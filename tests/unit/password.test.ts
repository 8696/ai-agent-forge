/**
 * tests/unit/password.test.ts
 * 对应 src/lib/password.ts
 * 详见 docs/12-d-需求-运维稳定.md §D6
 */
import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/lib/password';

describe('password · bcrypt hash + verify', () => {
  it('hash 跟明文不严格相等（bcrypt 是 hash）', async () => {
    const hash = await hashPassword('Hello-123');
    expect(hash).not.toBe('Hello-123');
    expect(hash.startsWith('$2')).toBe(true); // bcrypt 格式
  });

  it('verify 同一明文应返回 true', async () => {
    const hash = await hashPassword('Hello-123');
    expect(await verifyPassword('Hello-123', hash)).toBe(true);
  });

  it('verify 错密码应返回 false', async () => {
    const hash = await hashPassword('Hello-123');
    expect(await verifyPassword('Hello-456', hash)).toBe(false);
  });

  it('同一明文两次 hash 结果不同（bcrypt salt 随机）', async () => {
    const a = await hashPassword('Hello-123');
    const b = await hashPassword('Hello-123');
    expect(a).not.toBe(b);
    // 但两个 hash 都应该能 verify 同一明文
    expect(await verifyPassword('Hello-123', a)).toBe(true);
    expect(await verifyPassword('Hello-123', b)).toBe(true);
  });
});
