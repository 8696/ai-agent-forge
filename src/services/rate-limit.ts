import { config } from '../config';
import { logger } from '../logger';
import { writeAuditLog } from '../lib/audit-log';
import { consumeRateLimit, type RateLimitOutcome } from '../lib/rate-limit';
import { getSettingValue } from './tenant-settings';

/**
 * 限流 —— D5（docs/12-d-需求-运维稳定.md §D5）
 *
 * 两个维度同时限：
 *   - **租户**：防止一个租户把整台机器的 LLM 额度吃光
 *   - **用户**：防止租户里的单个账号刷接口
 *
 * 只限租户的话，租户里任何一个爱刷的用户就能把其他用户一起限掉；
 * 只限用户的话，一个租户开一百个用户就能把额度用光。两个都要。
 *
 * 阈值来源（三层回落，跟 docs/12-c §C4 的思路一致）：
 *   1. 租户配置 `rate_limit_per_minute`（后台「租户设置」可改，>0 时生效）
 *   2. 进程默认 `.env` 的 `RATE_LIMIT_MAX_REQUESTS` / `RATE_LIMIT_MAX_REQUESTS_PER_USER`
 *   3. 0 = 不限
 */

export interface RateLimitDecision {
  /** 放不放行 */
  allowed: boolean;
  /** 命中的上限（不限时为 0） */
  limit: number;
  /** 还剩几次 */
  remaining: number;
  /** 被拒时要等多久（毫秒） */
  retryAfterMs: number;
  /** 是哪个维度被拒了（null = 都放行） */
  scope: 'tenant' | 'user' | null;
  /** 租户维度当前用量（后台展示用） */
  tenantCount: number;
}

/** 限流的窗口长度（所有维度共用同一个窗口长度） */
function windowMs(): number {
  return config.RATE_LIMIT.WINDOW_MS;
}

/**
 * 检查一次请求是否超限，并**消耗一次配额**。
 *
 * @param tenantId 租户 id
 * @param userId   用户 id
 */
export async function checkRateLimit(
  tenantId: string,
  userId: string,
): Promise<RateLimitDecision> {
  if (!config.RATE_LIMIT.ENABLED) {
    return {
      allowed: true,
      limit: 0,
      remaining: Number.MAX_SAFE_INTEGER,
      retryAfterMs: 0,
      scope: null,
      tenantCount: 0,
    };
  }

  const configured = await getSettingValue(tenantId, 'rate_limit_per_minute');
  const tenantLimit =
    typeof configured === 'number' && configured > 0 ? configured : config.RATE_LIMIT.MAX_REQUESTS;

  const win = windowMs();
  const tenantOutcome = consumeRateLimit(`tenant:${tenantId}`, { limit: tenantLimit, windowMs: win });
  const userOutcome = consumeRateLimit(`user:${tenantId}:${userId}`, {
    limit: config.RATE_LIMIT.MAX_REQUESTS_PER_USER,
    windowMs: win,
  });

  const denied: RateLimitOutcome | null = !tenantOutcome.allowed
    ? tenantOutcome
    : !userOutcome.allowed
      ? userOutcome
      : null;

  if (denied === null) {
    return {
      allowed: true,
      limit: tenantLimit,
      remaining: Math.min(tenantOutcome.remaining, userOutcome.remaining),
      retryAfterMs: 0,
      scope: null,
      tenantCount: tenantOutcome.count,
    };
  }

  const scope: 'tenant' | 'user' = !tenantOutcome.allowed ? 'tenant' : 'user';
  logger.warn(
    { tenantId, userId, scope, count: denied.count, limit: denied.limit },
    '请求被限流拦下',
  );
  await writeAuditLog({
    tenant_id: tenantId,
    user_id: userId,
    action: 'RATE_LIMIT_EXCEEDED',
    resource_type: 'rate_limit',
    details: { scope, count: denied.count, limit: denied.limit, window_ms: win },
  });

  return {
    allowed: false,
    limit: denied.limit,
    remaining: 0,
    retryAfterMs: denied.retryAfterMs,
    scope,
    tenantCount: tenantOutcome.count,
  };
}
