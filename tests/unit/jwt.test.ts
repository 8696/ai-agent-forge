/**
 * tests/unit/jwt.test.ts
 * 对应 src/lib/jwt.ts
 * 详见 docs/12-d-需求-运维稳定.md §D6
 */
import { describe, it, expect } from 'vitest';
import { signToken, verifyToken } from '../../src/lib/jwt';

describe('jwt · sign + verify', () => {
  it('system payload · sign → verify 拿回', () => {
    const token = signToken({ sub: 'sys-1', role: 'system' });
    const decoded = verifyToken(token);
    expect(decoded.sub).toBe('sys-1');
    expect(decoded.role).toBe('system');
  });

  it('tenant user payload · sign → verify 拿回', () => {
    const token = signToken({ sub: 'user-1', tenant_id: 'tenant-1', role: 'admin' });
    const decoded = verifyToken(token);
    if (!('tenant_id' in decoded)) throw new Error('payload 缺 tenant_id');
    expect(decoded.sub).toBe('user-1');
    expect(decoded.tenant_id).toBe('tenant-1');
    expect(decoded.role).toBe('admin');
  });

  it('customer role 也能签', () => {
    const token = signToken({ sub: 'user-2', tenant_id: 'tenant-1', role: 'customer' });
    const decoded = verifyToken(token);
    if (!('tenant_id' in decoded)) throw new Error('payload 缺 tenant_id');
    expect(decoded.role).toBe('customer');
  });

  it('token 长度合理（JWT 三段式）', () => {
    const token = signToken({ sub: 'sys-1', role: 'system' });
    expect(token.split('.').length).toBe(3);
  });

  it('篡改 token → verify 抛 AuthError', () => {
    const token = signToken({ sub: 'sys-1', role: 'system' });
    const parts = token.split('.');
    const tampered = `${parts[0]}.${parts[1]}.invalid-signature`;
    expect(() => verifyToken(tampered)).toThrow();
  });

  it('非 JWT 字符串 → verify 抛 AuthError', () => {
    expect(() => verifyToken('not-a-jwt')).toThrow();
  });

  it('空字符串 → verify 抛 AuthError', () => {
    expect(() => verifyToken('')).toThrow();
  });
});
