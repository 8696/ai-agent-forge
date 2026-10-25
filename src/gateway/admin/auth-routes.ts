import Router from '@koa/router';
import { z } from 'zod';
import { User, Tenant } from '../../models';
import {
  verifyPassword,
  AuthError,
  signToken,
  recordFailedLogin,
  recordSuccessfulLogin,
  throwIfLocked,
  assertTenantAccessible,
} from '../../lib';
import { jwtAuth } from '../jwt-base';
import { requireAdmin } from './middleware';
import { changePasswordFor } from '../../services/change-password';
import { changePasswordSchema } from '../../lib/validators';
import { writeAuditLog } from '../../lib/audit-log';
import type { TenantUserJwtPayload } from '../../lib/jwt';

/**
 * admin 子系统：login / me / change-password 三件套
 *
 * 路由（都挂在 /api/v1/admin 下）：
 *   POST /login           {email, password, tenant_code} → { token, user }
 *   GET  /me                                   → { user }
 *   POST /change-password {old_password, new_password}
 *
 * ⚠️ **`/me` 和 `/change-password` 之前被删过**（注释写着「前端未用」），
 *    结果是 A4 的 19 个验收用例缺了 6 个，而且
 *    `must_change_password` 这个字段**从建表起就没人消费** ——
 *    平台方重置租户 admin 密码后，用户拿着临时密码长期用下去，没人被要求改。
 *
 * 三套子系统（admin / customer / system）各有一套，**不共用端点**——
 * 这是 A4 的硬要求（反例里明写「两个子系统共用一个 change-password 端点」是错的）。
 * 底层逻辑（校验旧密码 + 写新哈希 + 清标记）抽到 services/change-password.ts 复用。
 */
export const adminAuthRouter = new Router({ prefix: '/api/v1/admin' });

const AdminLoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  tenant_code: z
    .string()
    .min(3)
    .max(32)
    .regex(/^[a-z0-9-]+$/),
});

adminAuthRouter.post('/login', async (ctx) => {
  const input = AdminLoginBody.parse(ctx.request.body);

  const tenant = await Tenant.findOne({ where: { code: input.tenant_code } });
  if (tenant === null) {
    throw new AuthError('邮箱或密码错误');
  }

  // F2 · 租户闸门：status=disabled 或 expires_at 已过 → 401（与密码错同响应体）
  assertTenantAccessible(tenant);

  // 锁死在 admin 角色（agent 不进 admin 子系统——本产品没有「后台客服坐席」概念）
  const user = await User.findOne({
    where: {
      email: input.email,
      tenant_id: tenant.id,
      role: 'admin',
    },
  });
  if (user === null) {
    throw new AuthError('邮箱或密码错误');
  }
  throwIfLocked(user);

  if (user.password_hash === null) {
    throw new AuthError('邮箱或密码错误');
  }
  const ok = await verifyPassword(input.password, user.password_hash);
  if (!ok) {
    await recordFailedLogin(user);
    throw new AuthError('邮箱或密码错误');
  }

  await recordSuccessfulLogin(user);
  // ⚠️ 必须改密的账号：标志签进 token，服务端据此挡住除 /me 和 /change-password 外的所有请求
  const token = signToken({
    sub: user.id,
    tenant_id: tenant.id,
    role: user.role,
    ...(user.must_change_password ? { must_change_password: true } : {}),
  });
  ctx.body = {
    token,
    // ⚠️ 前端登录页在等这个字段（`user.must_change_password`）——
    //    没有它，「平台方重置了密码 → 用户必须自己改」这条就断在这儿
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      tenant_id: tenant.id,
      tenant_name: tenant.name,
      must_change_password: user.must_change_password,
    },
  };
});

/** 当前登录者是谁 —— 前端拿它显示邮箱 / 租户名，以及判断「要不要先改密码」 */
adminAuthRouter.get('/me', jwtAuth, requireAdmin, async (ctx) => {
  const u = ctx.state.adminUser as TenantUserJwtPayload;
  const user = await User.findByPk(u.sub);
  if (user === null || user.tenant_id !== u.tenant_id) {
    throw new AuthError('账号不存在或已被删除');
  }
  const tenant = await Tenant.findByPk(user.tenant_id);
  ctx.body = {
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      tenant_id: user.tenant_id,
      tenant_name: tenant?.name ?? null,
      must_change_password: user.must_change_password,
      last_login_at: user.last_login_at?.toISOString() ?? null,
    },
  };
});

/** 自己改密码（改完清掉 must_change_password 标记） */
adminAuthRouter.post('/change-password', jwtAuth, requireAdmin, async (ctx) => {
  const u = ctx.state.adminUser as TenantUserJwtPayload;
  const input = changePasswordSchema.parse(ctx.request.body);

  const user = await User.findByPk(u.sub);
  if (user === null || user.tenant_id !== u.tenant_id) {
    throw new AuthError('账号不存在或已被删除');
  }

  await changePasswordFor(user, input.old_password, input.new_password);

  await writeAuditLog({
    tenant_id: user.tenant_id,
    user_id: user.id,
    action: 'PASSWORD_CHANGED',
    resource_type: 'user',
    resource_id: user.id,
    // ⚠️ 密码永远不进 details —— 只记「改过」这个事实
    details: { self_service: true },
    ip: ctx.ip,
  });

  // ⚠️ **换一枚新 token**：旧 token 里还带着 `must_change_password=true`，
  //    不换的话用户改完密码还是被闸门挡着（前端拿到新 token 替换掉即可）。
  const token = signToken({ sub: user.id, tenant_id: user.tenant_id, role: user.role });
  ctx.body = { ok: true, token };
});
