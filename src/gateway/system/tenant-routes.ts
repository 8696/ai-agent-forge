import Router from '@koa/router';
import { z } from 'zod';
import { Op, type WhereOptions } from 'sequelize';
import { getSequelize } from '../../db';
import { Tenant, User, Session, Document, CostLog } from '../../models';
import { hashPassword } from '../../lib/password';
import {
  createTenantSchema,
  updateTenantSchema,
  updateTenantExpiresAtSchema,
  updateTenantStatusSchema,
  resetTenantAdminPasswordSchema,
} from '../../lib/validators';
import { writeAuditLog } from '../../lib/audit-log';
import { getSystemStats } from '../../services/system-stats';
import { NotFoundError, ValidationError } from '../../lib/errors';
import { jwtAuth } from '../jwt-base';
import { requireSystemUser } from './middleware';
import type { SystemJwtPayload } from '../../lib/jwt';

/**
 * system 子系统：租户管理（docs/12-e §F1 + §F2）
 * 路由前缀：/api/v1/system/tenants
 * 鉴权：requireSystemUser
 *
 * 端点：
 *   POST   /tenants                          建租户 + 初始化 admin（Step 2 已有）
 *   GET    /tenants                          列所有租户（含 admin email + F2 状态/到期）
 *   GET    /tenants/:id                      单租户详情（含 F2 状态/到期）
 *   PATCH  /tenants/:id                      改 name / plan（F1）
 *   PATCH  /tenants/:id/expires_at           F2：改到期时间（设或清空）
 *   PATCH  /tenants/:id/status               F2：启用 / 禁用（防系统租户自锁）
 *   POST   /tenants/:id/admin/reset-password 重置该租户 admin 的密码（F1）
 *   GET    /stats                            平台方总览（跨租户 KPI + 趋势）
 *
 * 写审计（2026-10-26 补齐 —— 之前只有 F2 两个 PATCH 写，建租户 / 改资料 /
 * 重置密码这三条「影响全局」的路径一条都没记）：
 *   TENANT_CREATED            建租户 + 连带建第一个 admin
 *   TENANT_UPDATED            改租户 name / plan
 *   TENANT_ADMIN_PASSWORD_RESET  重置租户 admin 密码
 *   TENANT_STATUS_CHANGE      F2：改 status
 *   TENANT_EXPIRES_CHANGE     F2：改 expires_at
 *   → audit_logs，tenant_id = NULL（系统级日志），操作人 = ctx.state.systemUser.id
 *   ⚠️ **密码永远不进 details** —— 只记「重置过」这个事实。
 */
export const systemTenantRouter = new Router({ prefix: '/api/v1/system' });

// ----- 建租户（Step 2 已有） -----
systemTenantRouter.post('/tenants', jwtAuth, requireSystemUser, async (ctx) => {
  const input = createTenantSchema.parse(ctx.request.body);
  const sequelize = getSequelize();

  const result = await sequelize.transaction(async (tx) => {
    const existing = await Tenant.findOne({ where: { code: input.code }, transaction: tx });
    if (existing !== null) {
      throw new ValidationError('租户号已被使用');
    }
    const tenant = await Tenant.create(
      {
        code: input.code,
        name: input.name,
        ...(input.plan !== undefined ? { plan: input.plan } : {}),
        expires_at:
          input.expires_at === undefined || input.expires_at === null
            ? null
            : new Date(input.expires_at),
      },
      { transaction: tx },
    );
    const admin = await User.create(
      {
        tenant_id: tenant.id,
        email: input.admin_email,
        password_hash: await hashPassword(input.admin_password),
        role: 'admin',
        must_change_password: true,
      },
      { transaction: tx },
    );
    return { tenant, admin };
  });

  const sysUser = ctx.state.systemUser as SystemJwtPayload;
  await writeAuditLog({
    tenant_id: null,
    user_id: sysUser.sub,
    action: 'TENANT_CREATED',
    resource_type: 'tenant',
    resource_id: result.tenant.id,
    details: {
      code: result.tenant.code,
      name: result.tenant.name,
      plan: result.tenant.plan,
      expires_at: result.tenant.expires_at,
      // 只记 admin 账号的邮箱，**不记密码**（哪怕是明文传进来的）
      admin_email: result.admin.email,
    },
    ip: ctx.ip,
  });

  ctx.status = 201;
  ctx.body = {
    tenant: {
      id: result.tenant.id,
      code: result.tenant.code,
      name: result.tenant.name,
      plan: result.tenant.plan,
      status: result.tenant.status,
      expires_at: result.tenant.expires_at,
    },
    admin: {
      id: result.admin.id,
      email: result.admin.email,
      role: result.admin.role,
      must_change_password: result.admin.must_change_password,
    },
  };
});

// ----- F1：列所有租户（F2：补 status / expires_at）-----
/** 转义 LIKE 通配符，否则搜 "100%" 会变成通配查询 */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * 列表的筛选条件 —— 04-d §6.1「租户列表」要求有搜索框 / 套餐筛选 / 状态筛选。
 *
 * ⚠️ **状态筛选是按「能不能用」算的**，不是只看 `tenants.status`：
 *    已到期（expires_at <= 现在）的租户在页面上要能筛出来单独看，
 *    否则「哪些租户快到期了 / 已经到期了」根本查不出来。
 */
const tenantListQuerySchema = z.object({
  /** 搜索：租户号或名称 */
  keyword: z.string().trim().max(100).optional(),
  /** 套餐筛选 */
  plan: z.enum(['free', 'pro', 'enterprise']).optional(),
  /** 状态筛选：active=正常 / disabled=已禁用 / expired=已到期 */
  status: z.enum(['active', 'disabled', 'expired']).optional(),
});

systemTenantRouter.get('/tenants', jwtAuth, requireSystemUser, async (ctx) => {
  const input = tenantListQuerySchema.parse(ctx.request.query ?? {});
  const now = Date.now();

  // ⚠️ where 要**合成一个** —— 分两次 spread 会后者覆盖前者（筛选就只剩套餐了）
  const where: WhereOptions<Tenant> = {
    ...(input.keyword !== undefined && input.keyword !== ''
      ? {
          [Op.or]: [
            { code: { [Op.like]: `%${escapeLike(input.keyword)}%` } },
            { name: { [Op.like]: `%${escapeLike(input.keyword)}%` } },
          ],
        }
      : {}),
    ...(input.plan !== undefined ? { plan: input.plan } : {}),
  };

  const tenants = await Tenant.findAll({
    where,
    order: [['created_at', 'DESC']],
  });

  const data = await Promise.all(
    tenants.map(async (t) => {
      const admin = await User.findOne({
        where: { tenant_id: t.id, role: 'admin' },
        order: [['created_at', 'ASC']],
        attributes: ['id', 'email', 'must_change_password'],
      });
      // 用户数（04-d §6.1 列表里有一列「用户数」）
      const userCount = await User.count({ where: { tenant_id: t.id } });
      const expired =
        t.expires_at !== null && t.expires_at.getTime() <= now;
      return {
        id: t.id,
        code: t.code,
        name: t.name,
        plan: t.plan,
        status: t.status, // F2
        expires_at: t.expires_at, // F2
        /** 已到期（时间过了）—— 跟 status='disabled' 是两回事 */
        expired,
        /** 该租户的用户总数 */
        user_count: userCount,
        created_at: t.created_at,
        admin:
          admin !== null
            ? { id: admin.id, email: admin.email, must_change_password: admin.must_change_password }
            : null,
      };
    }),
  );

  // 状态筛选在 JS 层做 —— 「已到期」是算出来的，不是列上的枚举值
  const filtered =
    input.status === undefined
      ? data
      : data.filter((t) =>
          input.status === 'expired' ? t.expired : t.status === input.status && !t.expired,
        );

  ctx.body = { tenants: filtered };
});

// ----- F1：单租户详情（F2：补 status / expires_at）-----
systemTenantRouter.get('/tenants/:id', jwtAuth, requireSystemUser, async (ctx) => {
  const tenant = await Tenant.findByPk(ctx.params.id);
  if (tenant === null) {
    throw new NotFoundError('租户');
  }
  const admin = await User.findOne({
    where: { tenant_id: tenant.id, role: 'admin' },
    order: [['created_at', 'ASC']],
    attributes: ['id', 'email', 'role', 'must_change_password', 'last_login_at'],
  });
  // 该租户的统计（04-d §6.1「租户详情页有这一块」）：
  // 用户数 / 会话数 / 文档数 / 累计花费。
  // ⚠️ 全部按 tenant_id 过滤 —— 平台方看的是**单个租户**的数，不是全平台的。
  const [userCount, sessionCount, documentCount, totalCost] = await Promise.all([
    User.count({ where: { tenant_id: tenant.id } }),
    Session.count({ where: { tenant_id: tenant.id } }),
    Document.count({ where: { tenant_id: tenant.id } }),
    CostLog.sum('cost', { where: { tenant_id: tenant.id } }),
  ]);

  ctx.body = {
    id: tenant.id,
    code: tenant.code,
    name: tenant.name,
    plan: tenant.plan,
    settings: tenant.settings,
    status: tenant.status, // F2
    expires_at: tenant.expires_at, // F2
    created_at: tenant.created_at,
    updated_at: tenant.updated_at,
    /** 该租户的规模统计 */
    stats: {
      user_count: userCount,
      session_count: sessionCount,
      document_count: documentCount,
      /** 累计花费（美元，估算值） */
      total_cost_usd: Number((totalCost ?? 0).toFixed(6)),
    },
    admin:
      admin !== null
        ? {
            id: admin.id,
            email: admin.email,
            role: admin.role,
            must_change_password: admin.must_change_password,
            last_login_at: admin.last_login_at,
          }
        : null,
  };
});

// ----- F1：改租户基本资料 -----
systemTenantRouter.patch('/tenants/:id', jwtAuth, requireSystemUser, async (ctx) => {
  const input = updateTenantSchema.parse(ctx.request.body);
  const tenant = await Tenant.findByPk(ctx.params.id);
  if (tenant === null) {
    throw new NotFoundError('租户');
  }
  const prev = { name: tenant.name, plan: tenant.plan };
  if (input.name !== undefined) tenant.name = input.name;
  if (input.plan !== undefined) tenant.plan = input.plan;
  await tenant.save();

  const sysUser = ctx.state.systemUser as SystemJwtPayload;
  await writeAuditLog({
    tenant_id: null,
    user_id: sysUser.sub,
    action: 'TENANT_UPDATED',
    resource_type: 'tenant',
    resource_id: tenant.id,
    details: {
      code: tenant.code,
      prev,
      next: { name: tenant.name, plan: tenant.plan },
    },
    ip: ctx.ip,
  });

  ctx.body = {
    id: tenant.id,
    code: tenant.code,
    name: tenant.name,
    plan: tenant.plan,
    settings: tenant.settings,
  };
});

// ----- F2：改租户到期时间 -----
//   expires_at=null   清空到期（永不过）
//   expires_at=ISO8601 设置到期时间
//   写 audit_logs：TENANT_EXPIRES_CHANGE
systemTenantRouter.patch('/tenants/:id/expires_at', jwtAuth, requireSystemUser, async (ctx) => {
  const id = ctx.params.id;
  const input = updateTenantExpiresAtSchema.parse(ctx.request.body);

  const tenant = await Tenant.findByPk(id);
  if (tenant === null) {
    throw new NotFoundError('租户');
  }

  const prev = tenant.expires_at;
  tenant.expires_at = input.expires_at === null ? null : new Date(input.expires_at);
  await tenant.save();

  const sysUser = ctx.state.systemUser as SystemJwtPayload;
  await writeAuditLog({
    tenant_id: null,
    user_id: sysUser.sub,
    action: 'TENANT_EXPIRES_CHANGE',
    resource_type: 'tenant',
    resource_id: id,
    details: { prev: prev, next: tenant.expires_at },
    ip: ctx.ip,
  });

  ctx.body = {
    ok: true,
    id: tenant.id,
    code: tenant.code,
    expires_at: tenant.expires_at,
  };
});

// ----- F2：租户启停 -----
//   status='disabled' → admin/customer/login 立刻 401（详见 auth-routes.ts 闸门）
//   防自锁：code='system' 的初始租户禁止改成 disabled
//   写 audit_logs：TENANT_STATUS_CHANGE
systemTenantRouter.patch('/tenants/:id/status', jwtAuth, requireSystemUser, async (ctx) => {
  const id = ctx.params.id;
  const input = updateTenantStatusSchema.parse(ctx.request.body);

  const tenant = await Tenant.findByPk(id);
  if (tenant === null) {
    throw new NotFoundError('租户');
  }
  // 防自锁
  if (tenant.code === 'system' && input.status === 'disabled') {
    throw new ValidationError('不能禁用系统初始租户');
  }

  const prev = tenant.status;
  tenant.status = input.status;
  await tenant.save();

  const sysUser = ctx.state.systemUser as SystemJwtPayload;
  await writeAuditLog({
    tenant_id: null,
    user_id: sysUser.sub,
    action: 'TENANT_STATUS_CHANGE',
    resource_type: 'tenant',
    resource_id: id,
    details: { prev, next: input.status },
    ip: ctx.ip,
  });

  ctx.body = {
    ok: true,
    id: tenant.id,
    code: tenant.code,
    status: tenant.status,
  };
});

// ----- F1：重置租户 admin 密码 -----
systemTenantRouter.post(
  '/tenants/:id/admin/reset-password',
  jwtAuth,
  requireSystemUser,
  async (ctx) => {
    const input = resetTenantAdminPasswordSchema.parse(ctx.request.body);

    const tenant = await Tenant.findByPk(ctx.params.id);
    if (tenant === null) {
      throw new NotFoundError('租户');
    }

    const admin = await User.findOne({
      where: { tenant_id: tenant.id, role: 'admin' },
      order: [['created_at', 'ASC']],
    });
    if (admin === null) {
      throw new NotFoundError('租户的 admin 账号');
    }

    admin.password_hash = await hashPassword(input.new_password);
    admin.must_change_password = true;
    await admin.save();

    const sysUser = ctx.state.systemUser as SystemJwtPayload;
    await writeAuditLog({
      tenant_id: null,
      user_id: sysUser.sub,
      action: 'TENANT_ADMIN_PASSWORD_RESET',
      // ⚠️ **resource 指租户**（跟另外两条 TENANT_* 一致）——
      //    被改的是「这个租户的 admin 密码」，租户才是主资源；
      //    具体动了哪个账号放进 details。
      resource_type: 'tenant',
      resource_id: tenant.id,
      details: {
        tenant_code: tenant.code,
        admin_id: admin.id,
        admin_email: admin.email,
        // **不记新密码**（哪怕它就是明文传进来的）—— 只记「重置过」这个事实
        must_change_password: true,
      },
      ip: ctx.ip,
    });

    ctx.body = {
      ok: true,
      admin: {
        id: admin.id,
        email: admin.email,
        must_change_password: admin.must_change_password,
      },
    };
  },
);

// ----- 平台方总览（docs/04-d §6.2）-----
// 跨租户 KPI：租户数 / 用户数 / 今日对话与成本 / 7 天趋势 / 本月超预算的租户。
// ⚠️ 这是**唯一**返回跨租户数字的端点，闸门是 requireSystemUser。
systemTenantRouter.get('/stats', jwtAuth, requireSystemUser, async (ctx) => {
  ctx.body = await getSystemStats();
});
