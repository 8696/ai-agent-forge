import type { Tenant } from '../models';
import { AuthError } from './errors';

/**
 * F2 · 租户启停 / 到期闸门
 * 详见 docs/12-e-需求-业务接入与平台运营.md F2 + docs/03-b-技术栈-后端栈.md §6.1.4
 *
 * 校验规则：
 *  - status === 'active'              （F2：disabled 的租户禁止登录）
 *  - expires_at === null               （NULL = 永不过）
 *    或 expires_at > now                （没到期）
 *
 * 任一不满足 → 抛 AuthError，message = '邮箱或密码错误'（跟密码错完全一致，防账号枚举 + 防泄漏租户内部状态）。
 *
 * 调用点：`src/gateway/admin/auth-routes.ts` 的 /login + `src/gateway/customer/auth-routes.ts` 的 /login
 *
 * 注意：在 `Tenant.findOne` 之后立刻调本函数；闸门失败时**不要**继续查 User（减少泄漏面）。
 */
export function assertTenantAccessible(tenant: Tenant): void {
  const now = new Date();
  if (
    tenant.status === 'disabled' ||
    (tenant.expires_at !== null && tenant.expires_at.getTime() <= now.getTime())
  ) {
    // 与密码错完全同响应体 → 防账号枚举 / 防泄漏「租户已到期」/「租户已禁用」
    throw new AuthError('邮箱或密码错误');
  }
}
