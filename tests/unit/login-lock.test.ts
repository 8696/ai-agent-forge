/**
 * tests/unit/login-lock.test.ts
 * 对应 src/lib/login-lock.ts
 * 详见 docs/12-d-需求-运维稳定.md §D6
 */
import { describe, it, expect } from 'vitest';
import {
  isAccountLocked,
  throwIfLocked,
  recordFailedLogin,
  recordSuccessfulLogin,
  MAX_FAILED_ATTEMPTS,
} from '../../src/lib/login-lock';

class FakeUser {
  failed_login_count = 0;
  locked_until: Date | null = null;
  last_login_at: Date | null = null;
  async save(): Promise<void> {
    // 不真存；测试在内存里
  }
}

describe('login-lock · 失败计数 + 锁定', () => {
  it('isAccountLocked: null → false', () => {
    expect(isAccountLocked(null)).toBe(false);
  });

  it('isAccountLocked: 过去的时间 → false', () => {
    expect(isAccountLocked(new Date(Date.now() - 1000))).toBe(false);
  });

  it('isAccountLocked: 未来的时间 → true', () => {
    expect(isAccountLocked(new Date(Date.now() + 60_000))).toBe(true);
  });

  it('throwIfLocked: 锁定中 → 抛 AuthError', () => {
    const u = new FakeUser();
    u.locked_until = new Date(Date.now() + 60_000);
    expect(() => throwIfLocked(u)).toThrow(/邮箱或密码错误/);
  });

  it('throwIfLocked: 未锁定 → 不抛', () => {
    const u = new FakeUser();
    expect(() => throwIfLocked(u)).not.toThrow();
  });

  it('recordFailedLogin: 计数 +1', async () => {
    const u = new FakeUser();
    await recordFailedLogin(u as unknown as Parameters<typeof recordFailedLogin>[0]);
    expect(u.failed_login_count).toBe(1);
    expect(u.locked_until).toBeNull();
  });

  it(`recordFailedLogin: 累计到 ${MAX_FAILED_ATTEMPTS} 次 → 自动锁定 15 分钟`, async () => {
    const u = new FakeUser();
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) {
      await recordFailedLogin(u as unknown as Parameters<typeof recordFailedLogin>[0]);
    }
    expect(u.failed_login_count).toBe(MAX_FAILED_ATTEMPTS);
    expect(u.locked_until).not.toBeNull();
    // 锁定时间 = now + 15 分钟（误差 1s）
    const expectMs = 15 * 60_000;
    const actualMs = (u.locked_until as Date).getTime() - Date.now();
    expect(actualMs).toBeGreaterThan(expectMs - 1000);
    expect(actualMs).toBeLessThan(expectMs + 1000);
  });

  it('recordSuccessfulLogin: 清零 + 清锁定 + 写 last_login_at', async () => {
    const u = new FakeUser();
    u.failed_login_count = 3;
    u.locked_until = new Date(Date.now() + 60_000);
    await recordSuccessfulLogin(u as unknown as Parameters<typeof recordSuccessfulLogin>[0]);
    expect(u.failed_login_count).toBe(0);
    expect(u.locked_until).toBeNull();
    expect(u.last_login_at).not.toBeNull();
  });
});
