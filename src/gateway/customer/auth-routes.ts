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
import type { TenantUserJwtPayload } from '../../lib/jwt';

/**
 * customer 子系统登录（docs/16-需求技术对照表 A4）
 *
 * 路由（都挂在 /api/v1/customer 下）：
 *   POST /login    {email, password, tenant_code}  → role=customer
 *
 * 其他 customer 功能（me / change-password / chat / sessions）已清空。
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
  const token = signToken({ sub: user.id, tenant_id: tenant.id, role: user.role });
  ctx.body = { token };
});

// 防止 unused import 警告
void ({} as TenantUserJwtPayload);
