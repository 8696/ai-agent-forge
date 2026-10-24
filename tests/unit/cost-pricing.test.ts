import { describe, it, expect } from 'vitest';
import { estimateCostUsd, findModelPrice } from '../../src/lib/cost-pricing';
import { currentMonth, monthRange } from '../../src/services/cost-tracking';

/**
 * 成本估算（src/lib/cost-pricing.ts）+ 月份区间（src/services/cost-tracking.ts）
 *
 * 注意：cost-tracking.ts 里 import 了 models（会连数据库），
 * 但这里只测它的**纯函数**部分 —— 月份标识和月区间计算。
 */

describe('estimateCostUsd · 基本计算', () => {
  it('输入 / 输出按各自单价算', () => {
    // glm-4.5：input 0.6 / output 2.2（美元 / 100 万 token）
    const cost = estimateCostUsd('glm-4.5', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    });
    expect(cost).toBeCloseTo(2.8, 6);
  });

  it('token 为 0 时花费为 0', () => {
    const cost = estimateCostUsd('glm-4.5', {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    });
    expect(cost).toBe(0);
  });

  it('缓存命中的 token 比普通输入便宜', () => {
    const usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 1_000_000,
      cache_write_tokens: 0,
    };
    const cached = estimateCostUsd('glm-4.5', usage);
    const plain = estimateCostUsd('glm-4.5', { ...usage, cache_read_tokens: 0, input_tokens: 1_000_000 });
    expect(cached).toBeLessThan(plain);
  });

  it('模型不在价格表里 → 0（表示未知，不是免费）', () => {
    const cost = estimateCostUsd('some-unknown-model-x', {
      input_tokens: 1000,
      output_tokens: 1000,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    });
    expect(cost).toBe(0);
  });

  it('前缀匹配：glm-4.6 能命中 glm-4 的价格', () => {
    expect(findModelPrice('glm-4.6')).not.toBeNull();
    expect(findModelPrice('glm-4.6-flash')).not.toBeNull();
  });

  it('更长的前缀优先', () => {
    // glm-4.5 和 glm-4 都在表里，glm-4.5 应该匹配更具体的那个
    const p = findModelPrice('glm-4.5');
    expect(p?.output).toBe(2.2);
  });

  it('估算值保留 6 位小数（DECIMAL(12,6)）', () => {
    const cost = estimateCostUsd('glm-4.5', {
      input_tokens: 1234,
      output_tokens: 5678,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    });
    const decimals = (cost.toString().split('.')[1] ?? '').length;
    expect(decimals).toBeLessThanOrEqual(6);
  });
});

describe('currentMonth / monthRange · 月份边界', () => {
  it('currentMonth 是 YYYY-MM', () => {
    expect(currentMonth(new Date(2026, 0, 15))).toBe('2026-01');
    expect(currentMonth(new Date(2026, 11, 31))).toBe('2026-12');
  });

  it('monthRange 覆盖整月', () => {
    const { start, end } = monthRange(new Date(2026, 4, 17));
    expect(start.getFullYear()).toBe(2026);
    expect(start.getMonth()).toBe(4);
    expect(start.getDate()).toBe(1);
    expect(end.getMonth()).toBe(5);
    expect(end.getDate()).toBe(1);
  });

  it('12 月的下一年是 1 月', () => {
    const { end } = monthRange(new Date(2026, 11, 10));
    expect(end.getFullYear()).toBe(2027);
    expect(end.getMonth()).toBe(0);
  });
});
