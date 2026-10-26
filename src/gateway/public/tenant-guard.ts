import { Tenant } from '../../models';
import { AppError, NotFoundError } from '../../lib/errors';
import type { ApiKeyPrincipal } from '../../lib/api-key-auth';

/**
 * 对外 API 的租户可用性闸门
 *
 * 两条对外链路（普通 REST API / admin 档）都要过这一关：
 * 被禁用或已到期的租户，对外一律拒绝 —— 否则租户到期后，
 * 已经发出去的 API Key 还能继续调（**钱还在花**）。
 *
 * ⚠️ 跟后台登录那条路的区别：
 *   - admin / customer 登录端点 → 401「邮箱或密码错误」（**跟密码错逐字段一致**，
 *     防账号枚举，也防泄漏租户内部状态）
 *   - 对外 API → 403 `TENANT_UNAVAILABLE`，文案直说「该租户的服务已暂停」
 *     （匿名侧没有「密码错」可以对齐，说清楚更有用）
 */
export async function resolveTenant(principal: ApiKeyPrincipal): Promise<Tenant> {
  const tenant = await Tenant.findByPk(principal.tenantId);
  if (tenant === null) {
    throw new NotFoundError('租户');
  }
  const now = Date.now();
  if (
    tenant.status === 'disabled' ||
    (tenant.expires_at !== null && tenant.expires_at.getTime() <= now)
  ) {
    throw new AppError('该租户的服务已暂停', 'TENANT_UNAVAILABLE', 403);
  }
  return tenant;
}
