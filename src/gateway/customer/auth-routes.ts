import Router from '@koa/router';
import { z } from 'zod';
import { User } from '../../models';
import { Tenant } from '../../models';
import {
  verifyPassword,
  AuthError,
  signToken,
  recordFailedLogin,
  recordSuccessfulLogin,
  throwIfLocked,
  hashPassword,
  NotFoundError,
  assertTenantAccessible,
} from '../../lib';
import { jwtAuth } from '../jwt-base';
import { requireCustomer } from './middleware';
import type { TenantUserJwtPayload } from '../../lib/jwt';

/**
 * customer 子系统（租户前台）：完整 auth 自闭环
 * 详见 docs/16-需求技术对照表 A4
 *
 * 路由（都挂在 /api/v1/customer 下）：
 *   POST /login             {email, password, tenant_code}
 *   GET  /me                当前用户视图
 *   POST /change-password   {old_password, new_password}
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

const ChangePasswordBody = z.object({
  old_password: z.string().min(1),
  new_password: z.string().min(8, '新密码至少 8 字符'),
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
  const token = signToken({ sub: user.id, tenant_id: tenant.id, role: user.role });
  ctx.body = { token };
});

customerAuthRouter.get('/me', jwtAuth, requireCustomer, async (ctx) => {
  const u = ctx.state.customerUser as TenantUserJwtPayload;
  const user = await User.findOne({
    where: { id: u.sub, tenant_id: u.tenant_id, role: 'customer' },
    attributes: ['id', 'email', 'role', 'must_change_password', 'last_login_at'],
  });
  if (user === null) {
    throw new NotFoundError('用户');
  }
  ctx.body = {
    id: user.id,
    email: user.email,
    role: user.role,
    tenant_id: u.tenant_id,
    must_change_password: user.must_change_password,
    last_login_at: user.last_login_at,
  };
});

customerAuthRouter.post('/change-password', jwtAuth, requireCustomer, async (ctx) => {
  const u = ctx.state.customerUser as TenantUserJwtPayload;
  const input = ChangePasswordBody.parse(ctx.request.body);

  const user = await User.findOne({
    where: { id: u.sub, tenant_id: u.tenant_id, role: 'customer' },
  });
  if (user === null) {
    throw new NotFoundError('用户');
  }
  if (user.password_hash === null) {
    throw new AuthError('账号未设置密码（异常状态）');
  }
  const ok = await verifyPassword(input.old_password, user.password_hash);
  if (!ok) {
    throw new AuthError('原密码错误');
  }
  user.password_hash = await hashPassword(input.new_password);
  user.must_change_password = false;
  await user.save();
  ctx.body = { ok: true };
});
