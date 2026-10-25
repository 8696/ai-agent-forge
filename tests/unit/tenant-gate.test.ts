/**
 * tests/unit/tenant-gate.test.ts
 * 对应 src/lib/tenant-gate.ts（F2 · 租户启停 / 到期闸门）
 * 详见 docs/12-d-需求-运维稳定.md §D6
 */
import { describe, it, expect } from 'vitest';
import { Tenant } from '../../src/models';
import { assertTenantAccessible } from '../../src/lib/tenant-gate';
import { AuthError } from '../../src/lib/errors';

// 用 Object.create 绕开 Sequelize 装饰器，直接构造"看起来像 Tenant"的实例
function fakeTenant(overrides: Partial<{ status: string; expires_at: Date | null }>): Tenant {
  const t = Object.create(Tenant.prototype) as Tenant;
  Object.assign(t, {
    id: 't-1',
    code: 'fake',
    name: 'Fake',
    plan: 'free',
    status: 'active',
    expires_at: null,
    ...overrides,
  });
  return t;
}

describe('tenant-gate · F2 闸门', () => {
  it('active + 永不过期 → 通过', () => {
    expect(() => assertTenantAccessible(fakeTenant({}))).not.toThrow();
  });

  it('active + 未来到期 → 通过', () => {
    expect(() =>
      assertTenantAccessible(
        fakeTenant({ expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000) }),
      ),
    ).not.toThrow();
  });

  it('disabled → 抛 AuthError「邮箱或密码错误」（防账号枚举）', () => {
    expect(() => assertTenantAccessible(fakeTenant({ status: 'disabled' }))).toThrow(AuthError);
    expect(() => assertTenantAccessible(fakeTenant({ status: 'disabled' }))).toThrow(
      /邮箱或密码错误/,
    );
  });

  it('已到期 → 抛 AuthError「邮箱或密码错误」', () => {
    expect(() =>
      assertTenantAccessible(
        fakeTenant({ expires_at: new Date(Date.now() - 1000) }),
      ),
    ).toThrow(/邮箱或密码错误/);
  });

  it('刚好到期（边界）→ 视为到期', () => {
    expect(() =>
      assertTenantAccessible(
        fakeTenant({ expires_at: new Date(Date.now() - 1) }),
      ),
    ).toThrow(/邮箱或密码错误/);
  });

  it('disabled + 未到期 → 也抛（任一不满足都抛）', () => {
    expect(() =>
      assertTenantAccessible(
        fakeTenant({
          status: 'disabled',
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
        }),
      ),
    ).toThrow(/邮箱或密码错误/);
  });
});
