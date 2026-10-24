import { describe, it, expect } from 'vitest';
import { resolveCostRange } from '../../src/services/observability';

/**
 * 成本分析的时间范围解析 —— D2（docs/12-d-需求-运维稳定.md §D2）
 *
 * 纯函数：给定 range 和 now，算出 [from, to)。
 * 「结束时间不含」是有意的 —— 区间是左闭右开 [from, to)，
 * 这样相邻两段（今天 / 本月）不会在边界上重复统计。
 */
describe('resolveCostRange', () => {
  const now = new Date(2026, 9, 24, 15, 30, 0); // 2026-10-24 15:30 本地时间

  it('day = 今天 00:00 到明天 00:00', () => {
    const { from, to } = resolveCostRange({ range: 'day', now });
    expect(from.getFullYear()).toBe(2026);
    expect(from.getMonth()).toBe(9);
    expect(from.getDate()).toBe(24);
    expect(from.getHours()).toBe(0);
    expect(to.getDate()).toBe(25);
    expect(to.getHours()).toBe(0);
  });

  it('week = 最近 7 天（含今天）', () => {
    const { from, to } = resolveCostRange({ range: 'week', now });
    expect(from.getDate()).toBe(18); // 24 - 6
    expect(from.getHours()).toBe(0);
    expect(to.getDate()).toBe(25);
    expect(to.getHours()).toBe(0);
  });

  it('month = 本月 1 号到下月 1 号', () => {
    const { from, to } = resolveCostRange({ range: 'month', now });
    expect(from.getDate()).toBe(1);
    expect(from.getMonth()).toBe(9);
    expect(to.getMonth()).toBe(10); // 11 月
    expect(to.getDate()).toBe(1);
  });

  it('custom = 用传入的 from / to', () => {
    const from = new Date(2026, 0, 1);
    const to = new Date(2026, 1, 1);
    const r = resolveCostRange({ range: 'custom', from, to, now });
    expect(r.from).toBe(from);
    expect(r.to).toBe(to);
  });

  it('custom 缺 from / to 时兜底成「最近 7 天到此刻」', () => {
    const { from, to } = resolveCostRange({ range: 'custom', now });
    expect(from.getTime()).toBeLessThanOrEqual(now.getTime() - 7 * 24 * 3600 * 1000);
    expect(to.getTime()).toBe(now.getTime());
  });

  it('区间是左闭右开（相邻两段不重复）', () => {
    const day = resolveCostRange({ range: 'day', now });
    const week = resolveCostRange({ range: 'week', now });
    expect(week.from.getTime()).toBeLessThan(day.from.getTime());
    expect(day.to.getTime()).toBeLessThanOrEqual(week.to.getTime());
  });
});
