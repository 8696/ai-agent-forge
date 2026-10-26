/**
 * tests/unit/api-key-sha256-degrade.test.ts
 *
 * 迁移 034 没跑时的降级判定 —— docs/12-e §E1
 *
 * ## 为什么要这个
 *
 * 生产部署是「DBA 手动跑迁移 + 灰度」（docs/11），
 * **代码可能先于迁移上线**。那时 `api_keys.key_sha256` 列不存在，
 * `SELECT ... WHERE key_sha256 = ?` 会直接报「未知列」——
 * 没有降级的话，**每一次 API Key 鉴权都 500**，对外 API 整个瘫掉。
 *
 * 降级策略：识别出「未知列」错误 → 退回老行为（前缀粗筛 + bcrypt），
 * 只是慢一点，不会挂。
 *
 * 这里只测**判定逻辑**（纯函数，不连库）；
 * 端到端的降级验证在 scratch 库里手工跑过（见 AGENTS.md 的交付记录）。
 */
import { describe, it, expect } from 'vitest';
import { isMissingColumnError, sha256OfApiKey } from '../../src/lib/api-key-auth';

describe('API Key · sha256 列缺失时的降级判定', () => {
  it('认得 mysql2 原始的「未知列」错误（ER_BAD_FIELD_ERROR / errno 1054）', () => {
    expect(isMissingColumnError({ code: 'ER_BAD_FIELD_ERROR', errno: 1054 })).toBe(true);
    expect(isMissingColumnError({ errno: 1054 })).toBe(true);
    expect(isMissingColumnError({ sqlState: '42S22' })).toBe(true);
  });

  it('认得 Sequelize 包过一层的样子（原始错误挂在 original / parent 上）', () => {
    const original = { code: 'ER_BAD_FIELD_ERROR', errno: 1054, message: "Unknown column 'key_sha256'" };
    expect(isMissingColumnError({ name: 'SequelizeDatabaseError', original })).toBe(true);
    expect(isMissingColumnError({ name: 'SequelizeDatabaseError', parent: original })).toBe(true);
    // 两层都挂着
    expect(
      isMissingColumnError({
        name: 'SequelizeDatabaseError',
        original,
        parent: { original },
      }),
    ).toBe(true);
  });

  it('别的错误**不**当成列缺失（不能把真故障降级掉）', () => {
    expect(isMissingColumnError({ code: 'ECONNREFUSED' })).toBe(false);
    expect(isMissingColumnError({ code: 'ER_DUP_ENTRY', errno: 1062 })).toBe(false);
    expect(isMissingColumnError(new Error('boom'))).toBe(false);
    expect(isMissingColumnError(null)).toBe(false);
    expect(isMissingColumnError(undefined)).toBe(false);
    expect(isMissingColumnError('字符串错误')).toBe(false);
  });

  it('sha256 的取值是确定性的 hex（缓存 key 和 DB 列共用同一个值）', () => {
    const a = sha256OfApiKey('ak_abc');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(sha256OfApiKey('ak_abc'));
    expect(a).not.toBe(sha256OfApiKey('ak_abd'));
  });
});
