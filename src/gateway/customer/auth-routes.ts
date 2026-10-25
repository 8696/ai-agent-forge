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
import { requireCustomer } from './middleware';
import { changePasswordFor } from '../../services/change-password';
import { changePasswordSchema } from '../../lib/validators';
import { writeAuditLog } from '../../lib/audit-log';
import type { TenantUserJwtPayload } from '../../lib/jwt';

/**
 * customer 子系统：login / me / change-password 三件套
 *
 * 路由（都挂在 /api/v1/customer 下）：
 *   POST /login           {email, password, tenant_code} → { token, user }
 *   GET  /me                                   → { user }
 *   POST /change-password {old_password, new_password}
 *
 * ⚠️ `/me` 和 `/change-password` 之前被删过（注释写着「前端未用」）。
 *    三套子系统各有一套，不共用端点（docs/12-a §A4 的反例里明写这是错的）。
 */
export const customerAuthRouter = new Router({ prefix: '/api/v1/customer' });

const CustomerLoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  tenant_code: z
    .string()
    .min(3)
    .max(32)
    .regex(/^[a-z0-9-]+$/),
});

customerAuthRouter.post('/login', async (ctx) => {
  const input = CustomerLoginBody.parse(ctx.request.body);

  const tenant = await Tenant.findOne({ where: { code: input.tenant_code } });
  if (tenant === null) {
    throw new AuthError('邮箱或密码错误');
  }

  // F2 · 租户闸门：status=disabled 或 expires_at 已过 → 401（与密码错同响应体）
  assertTenantAccessible(tenant);

  // 锁死在 customer 角色（不能拿 customer 账号去登 admin）
  const user = await User.findOne({
    where: { email: input.email, tenant_id: tenant.id, role: 'customer' },
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
  const token = signToken({
    sub: user.id,
    tenant_id: tenant.id,
    role: user.role,
    ...(user.must_change_password ? { must_change_password: true } : {}),
  });
  ctx.body = {
    token,
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

/** 当前登录者是谁 */
customerAuthRouter.get('/me', jwtAuth, requireCustomer, async (ctx) => {
  const u = ctx.state.customerUser as TenantUserJwtPayload;
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

/** 自己改密码 */
customerAuthRouter.post('/change-password', jwtAuth, requireCustomer, async (ctx) => {
  const u = ctx.state.customerUser as TenantUserJwtPayload;
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
    details: { self_service: true },
    ip: ctx.ip,
  });

  // ⚠️ **换一枚新 token**：旧 token 里还带着 `must_change_password=true`，
  //    不换的话用户改完密码还是被闸门挡着
  const token = signToken({ sub: user.id, tenant_id: user.tenant_id, role: user.role });
  ctx.body = { ok: true, token };
});
