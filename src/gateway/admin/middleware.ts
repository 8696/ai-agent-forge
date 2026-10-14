import type { Context, Next } from 'koa';
import type { JwtPayload, TenantUserJwtPayload } from '../../lib/jwt';
import { AuthError } from '../../lib/errors';

/**
 * admin 子系统：要求 token 是租户 admin（role=admin）
 * 通过后 ctx.state.adminUser 拿到类型收窄的 payload
 *
 * 注意：docs/05 的 users 表 role ENUM 里还有 'agent' 字段，但本产品没有「后台客服坐席」
 * 这个概念（前台用户直接由 AI 接待），所以 admin 端点只放 admin 角色进来
 */
export function requireAdmin(ctx: Context, next: Next): Promise<void> {
  const u = ctx.state.user as JwtPayload | undefined;
  if (u === undefined || !('tenant_id' in u)) {
    throw new AuthError('需要租户用户权限');
  }
  if (u.role !== 'admin') {
    throw new AuthError('需要 admin 角色');
  }
  ctx.state.adminUser = u as TenantUserJwtPayload;
  return next();
}
