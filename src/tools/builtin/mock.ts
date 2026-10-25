import { createHash } from 'node:crypto';

/**
 * 确定性 mock 数据生成 —— 内置工具的「假数据」来源
 *
 * 为什么要确定性：同一个租户、同一个单号，**每次查出来都一样**。
 * 随机数做不到这点（模型问两次得到两个不同答案，用户会以为系统不稳定），
 * 而且确定性数据才能写进测试断言。
 *
 * 为什么要掺 tenant_id：不同租户查同一个单号应该得到不同的结果 ——
 * 否则 A 租户看到的订单 B 租户也看得见，跨租户隔离就形同虚设。
 */

/** 由 (tenantId + 业务键) 派生的确定性伪随机整数 */
export function pickIndex(tenantId: string, key: string, length: number): number {
  const digest = createHash('sha256').update(`${tenantId}::${key}`).digest();
  return digest.readUInt32BE(0) % Math.max(1, length);
}

/** 由 (tenantId + 业务键) 派生一个确定性整数（取模到 [min, max]） */
export function pickNumber(
  tenantId: string,
  key: string,
  min: number,
  max: number,
): number {
  const digest = createHash('sha256').update(`${tenantId}::${key}::num`).digest();
  const span = Math.max(1, max - min + 1);
  return min + (digest.readUInt32BE(0) % span);
}

/** 从数组里确定性地挑一个 */
export function pickOne<T>(tenantId: string, key: string, list: readonly T[]): T {
  const item = list[pickIndex(tenantId, key, list.length)];
  // list 非空是调用方的约定；兜底成第一项，避免 undefined 流出
  return item ?? (list[0] as T);
}

/** 确定性地生成一个单号（带前缀） */
export function pickSerial(tenantId: string, key: string, prefix: string, length = 8): string {
  const digest = createHash('sha256').update(`${tenantId}::${key}::serial`).digest('hex');
  return prefix + digest.slice(0, length).toUpperCase();
}

/** 确定性地生成一个日期字符串（相对今天偏移 [-days, +days]） */
export function pickDate(tenantId: string, key: string, minDaysAgo: number, maxDaysAgo: number): string {
  const offset = pickNumber(tenantId, `${key}::date`, minDaysAgo, maxDaysAgo);
  const d = new Date(Date.now() - offset * 86_400_000);
  return d.toISOString().slice(0, 10);
}
