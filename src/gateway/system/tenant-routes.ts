import Router from '@koa/router';
import { getSequelize } from '../../db';
import { Tenant, User } from '../../models';
import { hashPassword } from '../../lib/password';
import {
  createTenantSchema,
  updateTenantSchema,
  updateTenantExpiresAtSchema,
  updateTenantStatusSchema,
  resetTenantAdminPasswordSchema,
} from '../../lib/validators';
import { writeAuditLog } from '../../lib/audit-log';
import { NotFoundError, ValidationError } from '../../lib/errors';
import { jwtAuth } from '../jwt-base';
import { requireSystemUser } from './middleware';
import type { SystemJwtPayload } from '../../lib/jwt';

/**
 * system 子系统：租户管理（docs/16 §F1 + §F2）
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
 *
 * F2 写审计：TENANT_STATUS_CHANGE / TENANT_EXPIRES_CHANGE → audit_logs
 *   tenant_id = NULL（系统级日志，操作人 = ctx.state.systemUser.id）
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
    const tenant = await Tenant.create({ code: input.code, name: input.name }, { transaction: tx });
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
systemTenantRouter.get('/tenants', jwtAuth, requireSystemUser, async (ctx) => {
  const tenants = await Tenant.findAll({
    order: [['created_at', 'DESC']],
  });
  const data = await Promise.all(
    tenants.map(async (t) => {
      const admin = await User.findOne({
        where: { tenant_id: t.id, role: 'admin' },
        order: [['created_at', 'ASC']],
        attributes: ['id', 'email', 'must_change_password'],
      });
      return {
        id: t.id,
        code: t.code,
        name: t.name,
        plan: t.plan,
        status: t.status, // F2
        expires_at: t.expires_at, // F2
        created_at: t.created_at,
        admin:
          admin !== null
            ? { id: admin.id, email: admin.email, must_change_password: admin.must_change_password }
            : null,
      };
    }),
  );
  ctx.body = { tenants: data };
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
  if (input.name !== undefined) tenant.name = input.name;
  if (input.plan !== undefined) tenant.plan = input.plan;
  await tenant.save();
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
