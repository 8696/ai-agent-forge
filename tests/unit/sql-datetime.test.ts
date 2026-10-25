import { describe, it, expect } from 'vitest';
import { utcWallClock } from '../../src/lib/sql-datetime';

/**
 * 原生 SQL 的时间参数 —— src/lib/sql-datetime.ts
 *
 * ⚠️ 这条转换看着多余，其实不是：
 *   - MySQL 的 DATETIME 列按 **UTC 墙钟**存（Sequelize 的模型写入路径）
 *   - `sequelize.query` 的 `replacements` 把 Date 渲染成 **本地**墙钟字符串
 *   - 两边对不上 → 时间窗口算错
 *
 * 2026-10-26 凌晨发现的真实 bug：服务器在 UTC+8，本地 00:20 时
 * 「今日对话数」恒为 0（每天的前 8 小时都错）。
 */
describe('utcWallClock · 原生 SQL 的时间参数', () => {
  it('按 UTC 墙钟输出（不是本地）', () => {
    // 本地时间 2026-10-26 00:20（UTC+8）= UTC 2026-10-25 16:20
    const d = new Date('2026-10-25T16:20:21.252Z');
    expect(utcWallClock(d)).toBe('2026-10-25 16:20:21');
  });

  it('不带毫秒和时区后缀 —— MySQL DATETIME 的字面量格式', () => {
    const d = new Date('2026-01-02T03:04:05.678Z');
    expect(utcWallClock(d)).toBe('2026-01-02 03:04:05');
    expect(utcWallClock(d)).not.toContain('T');
    expect(utcWallClock(d)).not.toContain('Z');
  });

  it('时区偏移不影响输出 —— 一律是 UTC 墙钟', () => {
    // 同一个 UTC 时刻，无论用什么方式构造，输出都一样
    const utc = new Date('2026-06-15T12:00:00.000Z');
    expect(utcWallClock(utc)).toBe('2026-06-15 12:00:00');
    expect(utcWallClock(new Date(utc.getTime()))).toBe(utcWallClock(utc));
  });

  it('跟 Date.prototype.toISOString 保持一致（截断到秒）', () => {
    const d = new Date('2026-03-04T05:06:07.891Z');
    expect(utcWallClock(d)).toBe(d.toISOString().slice(0, 19).replace('T', ' '));
  });
});
