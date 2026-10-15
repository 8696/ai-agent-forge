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

/**
 * admin 子系统：auth 端点只保留 login（/me / change-password 前端未用，已删）
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
  const token = signToken({ sub: user.id, tenant_id: tenant.id, role: user.role });
  ctx.body = { token };
});
