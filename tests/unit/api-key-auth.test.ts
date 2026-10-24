import { describe, it, expect } from 'vitest';
import type { Context } from 'koa';
import {
  API_KEY_PREFIX,
  API_KEY_PREFIX_LEN,
  extractApiKey,
  generateApiKey,
  hashApiKey,
  verifyApiKey,
} from '../../src/lib/api-key-auth';

/**
 * 对外 API Key 的生成 / 取出 —— E1
 *
 * 纯函数部分（不碰 DB，零成本）。真正跑 bcrypt + 查库的 verify 走集成测试
 * （tests/integration/public-api.test.ts）。
 */

/** 造一个只有 request.headers 的假 ctx（extractApiKey 只看这个） */
function fakeCtx(headers: Record<string, string | string[]>): Context {
  return { request: { headers } } as unknown as Context;
}

describe('api-key-auth · 密钥生成', () => {
  it('生成的 key 以 ak_ 开头（跟 seed 出来的格式一致）', () => {
    const { raw } = generateApiKey();
    expect(raw.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(raw.startsWith('ak_')).toBe(true);
  });

  it('key_prefix 取前 8 位（DDL 里 key_prefix VARCHAR(10) 存这个）', () => {
    const { raw, prefix } = generateApiKey();
    expect(prefix).toBe(raw.slice(0, API_KEY_PREFIX_LEN));
    expect(prefix).toHaveLength(8);
  });

  it('每次生成都是不同的 key', () => {
    const keys = new Set(Array.from({ length: 20 }, () => generateApiKey().raw));
    expect(keys.size).toBe(20);
  });

  it('hash 出来的是 bcrypt hash（不落明文）', async () => {
    const { raw } = generateApiKey();
    const hash = await hashApiKey(raw);
    expect(hash.startsWith('$2')).toBe(true);
    expect(hash).not.toContain(raw);
  });
});

describe('api-key-auth · 从请求头取 key', () => {
  it('Authorization: Bearer <key>', () => {
    const ctx = fakeCtx({ authorization: 'Bearer ak_abcdefgh' });
    expect(extractApiKey(ctx)).toBe('ak_abcdefgh');
  });

  it('X-API-Key: <key>', () => {
    const ctx = fakeCtx({ 'x-api-key': 'ak_abcdefgh' });
    expect(extractApiKey(ctx)).toBe('ak_abcdefgh');
  });

  it('两个头都有时优先 Authorization', () => {
    const ctx = fakeCtx({ authorization: 'Bearer ak_first', 'x-api-key': 'ak_second' });
    expect(extractApiKey(ctx)).toBe('ak_first');
  });

  it('没有这两个头 → null', () => {
    expect(extractApiKey(fakeCtx({}))).toBeNull();
  });

  it('Bearer 后面是空的 → null', () => {
    expect(extractApiKey(fakeCtx({ authorization: 'Bearer   ' }))).toBeNull();
  });
});

describe('api-key-auth · 明显不是 key 的输入直接拒（不查库、不跑 bcrypt）', () => {
  it('空串 / 非 ak_ 前缀 / 太短 → 判无效', async () => {
    expect(await verifyApiKey('')).toBeNull();
    expect(await verifyApiKey('not-a-key')).toBeNull();
    expect(await verifyApiKey('ak_123')).toBeNull();
  });
});
