/**
 * 进程内限流 —— docs/12-d-需求-运维稳定.md §D5
 *
 * 固定窗口计数：一个 key 一个 { count, resetAt }，窗口过期就重置。
 *
 * 为什么不上 Redis：docs/03-b §B.5 明确「进程内 Map（不上 Redis）」——
 * 单进程部署够用，多实例部署时再升级（那时每个实例各限各的，
 * 实际上限会放大到实例数倍，这是已知的取舍，不是 bug）。
 *
 * 为什么不用漏桶 / 滑动窗口：固定窗口在窗口边界允许「2 倍流量」突刺
 * （比如 60 秒窗口的第 59 秒和第 61 秒各打满）。对「防刷」这个目标够用，
 * 真要平滑就得换成滑动窗口，代价是每次请求都要维护一个时间戳队列。
 *
 * ⚠️ Map 是进程内的，重启即清零 —— 限流只是防随手刷，不承担安全边界。
 */

export interface RateLimitRule {
  /** 窗口内允许的最大请求数；<= 0 表示不限 */
  limit: number;
  /** 窗口长度（毫秒） */
  windowMs: number;
}

export interface RateLimitOutcome {
  /** 这次请求放不放行 */
  allowed: boolean;
  /** 当前生效的上限（<= 0 = 不限） */
  limit: number;
  /** 窗口内还剩几次（不限时为 Number.MAX_SAFE_INTEGER） */
  remaining: number;
  /** 被拒时，客户端要等多久（毫秒） */
  retryAfterMs: number;
  /** 本次计数后的窗口内总次数 */
  count: number;
}

interface Window {
  count: number;
  resetAt: number;
}

/** key → 计数窗口 */
const windows = new Map<string, Window>();

/**
 * 定期清理过期窗口 —— 不清理的话 Map 会随着 key 数量无限增长
 * （每个用户、每个 IP 都是一个 key）。超过阈值就扫一遍。
 */
const SWEEP_THRESHOLD = 10_000;

function sweep(now: number): void {
  for (const [key, w] of windows) {
    if (w.resetAt <= now) {
      windows.delete(key);
    }
  }
}

/**
 * 消耗一次配额。
 *
 * @param key 限流维度标识，比如 `tenant:<id>` / `user:<id>`
 */
export function consumeRateLimit(key: string, rule: RateLimitRule): RateLimitOutcome {
  const { limit, windowMs } = rule;

  // limit <= 0 = 不限流，直接放行（不占 Map）
  if (limit <= 0 || windowMs <= 0) {
    return {
      allowed: true,
      limit,
      remaining: Number.MAX_SAFE_INTEGER,
      retryAfterMs: 0,
      count: 0,
    };
  }

  const now = Date.now();

  if (windows.size > SWEEP_THRESHOLD) {
    sweep(now);
  }

  const existing = windows.get(key);
  if (existing === undefined || existing.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return {
      allowed: true,
      limit,
      remaining: Math.max(0, limit - 1),
      retryAfterMs: 0,
      count: 1,
    };
  }

  existing.count += 1;
  const allowed = existing.count <= limit;
  return {
    allowed,
    limit,
    remaining: Math.max(0, limit - existing.count),
    retryAfterMs: allowed ? 0 : Math.max(0, existing.resetAt - now),
    count: existing.count,
  };
}

/** 只看当前状态，不消耗配额（给「还剩几次」这类展示用） */
export function peekRateLimit(key: string, rule: RateLimitRule): RateLimitOutcome {
  const { limit, windowMs } = rule;
  if (limit <= 0 || windowMs <= 0) {
    return {
      allowed: true,
      limit,
      remaining: Number.MAX_SAFE_INTEGER,
      retryAfterMs: 0,
      count: 0,
    };
  }
  const now = Date.now();
  const existing = windows.get(key);
  if (existing === undefined || existing.resetAt <= now) {
    return { allowed: true, limit, remaining: limit, retryAfterMs: 0, count: 0 };
  }
  return {
    allowed: existing.count < limit,
    limit,
    remaining: Math.max(0, limit - existing.count),
    retryAfterMs: Math.max(0, existing.resetAt - now),
    count: existing.count,
  };
}

/** 清空所有计数 —— 只给测试用 */
export function resetRateLimits(): void {
  windows.clear();
}
