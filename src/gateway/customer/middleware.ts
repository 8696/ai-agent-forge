import type { Context, Next } from 'koa';
import type { JwtPayload, TenantUserJwtPayload } from '../../lib/jwt';
import { AuthError } from '../../lib/errors';
import { assertPasswordChanged } from '../password-change-gate';

/**
 * customer 子系统：要求 token 是租户前台用户（role=customer）
 * 通过后 ctx.state.customerUser 拿到类型收窄的 payload
 *
 * 与 admin 侧 requireAdmin 一一对应（docs/03-b §B.5.5）：
 * 三套子系统的鉴权各自自闭环，中间件不共用 —— 将来拆到不同子域 / 不同微服务时，
 * 这里的代码不用改。
 *
 * 跨子系统防御：admin 的 token 打 customer 端点会被这里 401 挡掉，
 * 反过来 customer 的 token 也进不了 admin（那边判 role === 'admin'）。
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
  // 被要求先改密码的账号，除了 /me 和 /change-password 之外一律挡住
  assertPasswordChanged(ctx);
  return next();
}