import { describe, it, expect, beforeEach } from 'vitest';
import {
  consumeRateLimit,
  peekRateLimit,
  resetRateLimits,
} from '../../src/lib/rate-limit';

/**
 * 进程内限流（src/lib/rate-limit.ts）—— 纯逻辑
 *
 * D5 的验收原话：「同一租户 1 分钟发 100 个请求 → 第 101 个返回 429」
 *
 * 这里锁住的语义：
 *  1. 第 N+1 个请求被拒，前 N 个放行
 *  2. 不同 key 互不影响（租户之间、用户之间）
 *  3. limit <= 0 = 不限流
 *  4. peek 不消耗配额
 */

const RULE = { limit: 100, windowMs: 60_000 };

describe('consumeRateLimit · 基本语义', () => {
  beforeEach(() => {
    resetRateLimits();
  });

  it('前 100 个请求放行，第 101 个被拒', () => {
    for (let i = 0; i < 100; i += 1) {
      expect(consumeRateLimit('tenant:a', RULE).allowed).toBe(true);
    }
    const denied = consumeRateLimit('tenant:a', RULE);
    expect(denied.allowed).toBe(false);
    expect(denied.count).toBe(101);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  it('remaining 随消耗递减', () => {
    expect(consumeRateLimit('tenant:a', RULE).remaining).toBe(99);
    expect(consumeRateLimit('tenant:a', RULE).remaining).toBe(98);
  });

  it('不同 key 互不影响', () => {
    for (let i = 0; i < 100; i += 1) {
      consumeRateLimit('tenant:a', RULE);
    }
    expect(consumeRateLimit('tenant:a', RULE).allowed).toBe(false);
    expect(consumeRateLimit('tenant:b', RULE).allowed).toBe(true);
  });

  it('limit <= 0 = 不限流', () => {
    const out = consumeRateLimit('tenant:a', { limit: 0, windowMs: 60_000 });
    expect(out.allowed).toBe(true);
    expect(out.remaining).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('windowMs <= 0 = 不限流', () => {
    expect(consumeRateLimit('tenant:a', { limit: 10, windowMs: 0 }).allowed).toBe(true);
  });

  it('窗口过期后重新计数', async () => {
    // 窗口 40ms：第二次调用紧跟着（还没过期）→ 被拒；
    // 睡 60ms 之后窗口翻页 → 重新放行
    const shortRule = { limit: 1, windowMs: 40 };
    expect(consumeRateLimit('tenant:a', shortRule).allowed).toBe(true);
    expect(consumeRateLimit('tenant:a', shortRule).allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(consumeRateLimit('tenant:a', shortRule).allowed).toBe(true);
  });
});

describe('peekRateLimit · 不消耗配额', () => {
  beforeEach(() => {
    resetRateLimits();
  });

  it('peek 不改变计数', () => {
    consumeRateLimit('tenant:a', RULE);
    const before = peekRateLimit('tenant:a', RULE);
    const after = peekRateLimit('tenant:a', RULE);
    expect(after.count).toBe(before.count);
    // 计数还是 1 → 还能再放行 99 个
    expect(consumeRateLimit('tenant:a', RULE).count).toBe(2);
  });

  it('没请求过时 remaining = limit', () => {
    expect(peekRateLimit('tenant:new', RULE).remaining).toBe(RULE.limit);
  });
});

describe('resetRateLimits · 测试用', () => {
  it('清空后计数归零', () => {
    consumeRateLimit('tenant:a', RULE);
    resetRateLimits();
    expect(peekRateLimit('tenant:a', RULE).count).toBe(0);
  });
});
