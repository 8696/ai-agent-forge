import type { Context, Next } from 'koa';
import type { JwtPayload, SystemJwtPayload } from '../../lib/jwt';
import { AuthError } from '../../lib/errors';

/**
 * system 子系统：要求 token 是 system user（role=system）
 * 通过后 ctx.state.systemUser 拿到类型收窄的 payload
 */
export function requireSystemUser(ctx: Context, next: Next): Promise<void> {
  const u = ctx.state.user as JwtPayload | undefined;
  if (u === undefined || !('role' in u) || u.role !== 'system') {
    throw new AuthError('需要 system user 权限');
  }
  ctx.state.systemUser = u as SystemJwtPayload;
  return next();
}
