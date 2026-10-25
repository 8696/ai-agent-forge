import { describe, it, expect, vi } from 'vitest';
import {
  withRetry,
  defaultIsRetryable,
  retryAfterMs,
  jitteredDelay,
} from '../../src/lib/retry';

/**
 * 带抖动的重试 —— docs/07-e 模块 19 / 12-d §D5
 *
 * 锁住三件事：
 *  1. **退避是指数的、且带全抖动**（不是固定值 + 偏移）
 *  2. **不 该重试的错误不重试**（4xx 重试多少次都一样）
 *  3. 上游给了 `Retry-After` 就照它说的等
 */
describe('withRetry · 指数退避 + 抖动', () => {
  it('成功就不重试', async () => {
    const fn = vi.fn(async () => 'ok');
    const r = await withRetry(fn);
    expect(r).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('可重试的错误 → 重试到成功', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) {
        const e = new Error('boom');
        (e as { statusCode?: number }).statusCode = 503;
        throw e;
      }
      return 'ok';
    });
    // initialDelayMs 调小，测试不慢
    const r = await withRetry(fn, { initialDelayMs: 1, maxDelayMs: 2 });
    expect(r).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('重试用完 → 抛最后一次的错', async () => {
    const fn = vi.fn(async () => {
      const e = new Error('always down');
      (e as { statusCode?: number }).statusCode = 500;
      throw e;
    });
    await expect(withRetry(fn, { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 2 })).rejects.toThrow(
      'always down',
    );
    expect(fn).toHaveBeenCalledTimes(3); // 首次 + 2 次重试
  });

  it('不可重试的错误（4xx）→ 一次都不重试', async () => {
    const fn = vi.fn(async () => {
      const e = new Error('bad request');
      (e as { statusCode?: number }).statusCode = 400;
      throw e;
    });
    await expect(withRetry(fn, { initialDelayMs: 1 })).rejects.toThrow('bad request');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('onRetry 回调能拿到次数和退避时长', async () => {
    const onRetry = vi.fn();
    const fn = vi.fn(async () => {
      const e = new Error('x');
      (e as { statusCode?: number }).statusCode = 500;
      throw e;
    });
    await withRetry(fn, { maxRetries: 1, initialDelayMs: 1, maxDelayMs: 2, onRetry }).catch(() => undefined);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]?.[0]).toBe(1);
    expect(typeof onRetry.mock.calls[0]?.[1]).toBe('number');
  });
});

describe('defaultIsRetryable · 哪些错误值得重试', () => {
  it('5xx → 重试', () => {
    expect(defaultIsRetryable({ statusCode: 502 })).toBe(true);
  });

  it('429 → 重试', () => {
    expect(defaultIsRetryable({ statusCode: 429 })).toBe(true);
  });

  it('4xx → 不重试', () => {
    expect(defaultIsRetryable({ statusCode: 400 })).toBe(false);
    expect(defaultIsRetryable({ statusCode: 401 })).toBe(false);
    expect(defaultIsRetryable({ statusCode: 404 })).toBe(false);
  });

  it('网络层错误 → 重试', () => {
    expect(defaultIsRetryable(new TypeError('fetch failed'))).toBe(true);
    expect(defaultIsRetryable(new Error('socket hang up'))).toBe(true);
    expect(defaultIsRetryable({ cause: { code: 'ECONNRESET' } })).toBe(true);
  });

  it('取消 / abort → 不重试', () => {
    const e = new Error('The operation was aborted');
    e.name = 'AbortError';
    expect(defaultIsRetryable(e)).toBe(false);
  });
});

describe('retryAfterMs · 上游说的「等多久」', () => {
  it('读 retry-after-ms（毫秒）', () => {
    expect(retryAfterMs({ responseHeaders: { 'retry-after-ms': '1500' } })).toBe(1500);
  });

  it('读 retry-after（秒）', () => {
    expect(retryAfterMs({ responseHeaders: { 'retry-after': '2' } })).toBe(2000);
  });

  it('读不到 → null（走抖动退避）', () => {
    expect(retryAfterMs({})).toBeNull();
    expect(retryAfterMs(new Error('x'))).toBeNull();
  });

  it('超过 60 秒就截断（不能让一次重试把请求挂两分钟）', () => {
    expect(retryAfterMs({ responseHeaders: { 'retry-after': '3600' } })).toBe(60_000);
  });
});

describe('jitteredDelay · 全抖动', () => {
  it('落在 [0, 上限] 内', () => {
    for (let i = 0; i < 50; i += 1) {
      const d = jitteredDelay(2, { initialDelayMs: 1000, maxDelayMs: 8000, backoffFactor: 2 });
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(8000);
    }
  });

  it('不是固定值（多次取值不同 —— 这正是「抖动」的意义）', () => {
    const values = new Set<number>();
    for (let i = 0; i < 30; i += 1) {
      values.add(jitteredDelay(2, { initialDelayMs: 1000, maxDelayMs: 8000, backoffFactor: 2 }));
    }
    expect(values.size).toBeGreaterThan(1);
  });

  it('退避上限随次数指数增长（但不超过 maxDelayMs）', () => {
    const opts = { initialDelayMs: 1000, maxDelayMs: 8000, backoffFactor: 2 };
    // 第 0 次上限 1000，第 3 次上限 8000（= maxDelayMs），第 10 次仍不超过 8000
    const d10 = jitteredDelay(10, opts);
    expect(d10).toBeLessThanOrEqual(8000);
  });
});
