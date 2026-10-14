import type { Context, Next } from 'koa';
import type { JwtPayload, TenantUserJwtPayload } from '../../lib/jwt';
import { AuthError } from '../../lib/errors';

/**
 * customer 子系统：要求 token 是租户 customer（role=customer）
 * 通过后 ctx.state.customerUser 拿到类型收窄的 payload
 */
export function requireCustomer(ctx: Context, next: Next): Promise<void> {
  const u = ctx.state.user as JwtPayload | undefined;
  if (u === undefined || !('tenant_id' in u)) {
    throw new AuthError('需要租户用户权限');
  }
  if (u.role !== 'customer') {
    throw new AuthError('需要 customer 角色');
  }
  ctx.state.customerUser = u as TenantUserJwtPayload;
  return next();
}
