import type { Context } from 'koa';
import { ForbiddenError } from '../lib/errors';
import type { TenantUserJwtPayload } from '../lib/jwt';

/**
 * 「必须先改密码」闸门 —— docs/12-a §A4 / docs/12-e §F1
 *
 * 平台方重置租户 admin 密码时会置 `must_change_password=true`
 * （src/gateway/system/tenant-routes.ts 的 reset-password 端点）。
 * 这个标志**签进 JWT**（见 src/lib/jwt.ts），所以每个请求都能零 DB 往返地检查它。
 *
 * 挡住的：除 `/me` 和 `/change-password` 之外的所有请求。
 *
 * 💡 **用 403 不用 401**：401 会让前端以为「登录过期了」，
 * 从而把用户踢回登录页 —— 而他正被要求改密，改完才能用，
 * 踢回登录页就成了死循环。
 */
const ALLOWED_PATHS = new Set([
  '/api/v1/admin/me',
  '/api/v1/admin/change-password',
  '/api/v1/customer/me',
  '/api/v1/customer/change-password',
]);

export function assertPasswordChanged(ctx: Context): void {
  const u = ctx.state.user as TenantUserJwtPayload | undefined;
  if (u === undefined || u.must_change_password !== true) {
    return;
  }
  if (ALLOWED_PATHS.has(ctx.path)) {
    return;
  }
  throw new ForbiddenError('请先修改初始密码');
}
