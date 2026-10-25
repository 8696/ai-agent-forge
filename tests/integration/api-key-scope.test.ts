/**
 * tests/integration/api-key-scope.test.ts
 * E1 · API Key 权限分级（read / write / admin）
 *
 * 对应 src/lib/api-key-auth.ts（requireApiScope）
 *        src/gateway/public/api-routes.ts（GET /search、POST /chat、/chat/stream）
 *        src/gateway/public/api-key-admin-routes.ts（创建 / 改权限）
 *
 * ⚠️ **回归**：`api_keys` 表**从来没有 scope 列** ——
 *    规格（docs/10-安全方案.md §10）写着「权限按 scope 分（只读 / 写入 / 管理员）」，
 *    但一把 key 能调该租户的全部对外端点。
 *    对外的 key 是**发到客户系统里**的，泄露一次就是「整租户的问答能力 + token 花费」全敞。
 *
 * 本文件**不调 LLM**：所有用例都在鉴权这一层就返回了，零费用。
 *
 * 前置条件：后端起在 3099（NODE_ENV=test PORT=3099 tsx src/server.ts）
 * 跑在别的端口上时用 API_BASE=http://localhost:<port> 覆盖。
 */
import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import axios from 'axios';
import { allHttpFromTokensFile, type AllHttp } from '../helpers';
import { getSequelize } from '../../src/db';
import { ApiKey } from '../../src/models';

function base(): string {
  return process.env.API_BASE ?? `http://localhost:${process.env.PORT ?? '3099'}`;
}

describe('E1 · API Key 权限分级', () => {
  let http: AllHttp;
  const createdKeyIds: string[] = [];

  beforeAll(async () => {
    getSequelize();
    http = await allHttpFromTokensFile();
  });

  afterAll(async () => {
    if (createdKeyIds.length > 0) {
      await ApiKey.destroy({ where: { id: createdKeyIds } });
    }
  });

  /** 建一把指定权限的 key（走后台管理端点，顺带验那条路也通） */
  const createKey = async (scope: 'read' | 'write' | 'admin'): Promise<string> => {
    const res = await http.acmeAdmin.post(
      '/api-keys',
      { name: `测试-scope-${scope}-${Date.now()}`, scope },
      { validateStatus: () => true },
    );
    expect(res.status).toBe(201);
    const body = res.data as { id: string; api_key: string; scope: string };
    expect(body.scope).toBe(scope);
    createdKeyIds.push(body.id);
    return body.api_key;
  };

  const asKey = (key: string): ReturnType<typeof axios.create> =>
    axios.create({
      baseURL: base(),
      headers: { Authorization: `Bearer ${key}` },
      validateStatus: () => true,
    });

  it('read 级 key：能查知识库', async () => {
    const key = await createKey('read');
    const res = await asKey(key).get('/api/v1/public/search', { params: { q: '年假' } });
    expect(res.status).toBe(200);
    const body = res.data as { hits: unknown[]; took_ms: number };
    expect(Array.isArray(body.hits)).toBe(true);
  });

  it('read 级 key：发起对话被挡（403），不是 401', async () => {
    const key = await createKey('read');
    const res = await asKey(key).post('/api/v1/public/chat', { question: '年假几天' });
    // 403 = key 有效但权限不够；401 会让调用方以为 key 失效了从而反复换 key
    expect(res.status).toBe(403);
  });

  it('read 级 key：流式提问也被挡', async () => {
    const key = await createKey('read');
    const res = await asKey(key).post('/api/v1/public/chat/stream', { question: '年假几天' });
    expect(res.status).toBe(403);
  });

  it('write 级 key：能查知识库，也能发起对话', async () => {
    const key = await createKey('write');

    const search = await asKey(key).get('/api/v1/public/search', { params: { q: '年假' } });
    expect(search.status).toBe(200);

    // ⚠️ 这一步会真的调 LLM（花钱）—— 但**鉴权过了**才会走到那，
    // 所以这里只断言「不是 401/403」，不关心回答内容。
    const chat = await asKey(key).post('/api/v1/public/chat', { question: '年假几天' });
    expect([401, 403]).not.toContain(chat.status);
  });

  it('admin 级 key：权限不低于 write', async () => {
    const key = await createKey('admin');
    const res = await asKey(key).post('/api/v1/public/chat', { question: '年假几天' });
    expect([401, 403]).not.toContain(res.status);
  });

  it('改权限立刻生效（write → read 后，对话被挡）', async () => {
    const key = await createKey('write');

    // 改之前：鉴权通过
    const before = await asKey(key).post('/api/v1/public/chat', { question: '年假几天' });
    expect([401, 403]).not.toContain(before.status);

    // 改成 read
    const patched = await http.acmeAdmin.patch(
      `/api-keys/${createdKeyIds[createdKeyIds.length - 1]}`,
      { scope: 'read' },
      { validateStatus: () => true },
    );
    expect(patched.status).toBe(200);
    expect((patched.data as { scope: string }).scope).toBe('read');

    // ⚠️ 改完立刻生效 —— 服务端会清掉这把 key 的鉴权缓存
    //    （不清的话最多还有 60 秒的窗口期旧权限仍然生效）
    const after = await asKey(key).post('/api/v1/public/chat', { question: '年假几天' });
    expect(after.status).toBe(403);
  });

  it('列表里能看到每把 key 的权限', async () => {
    const res = await http.acmeAdmin.get('/api-keys', { validateStatus: () => true });
    expect(res.status).toBe(200);
    const body = res.data as { keys: Array<{ scope?: string }> };
    expect(body.keys.length).toBeGreaterThan(0);
    for (const k of body.keys) {
      expect(['read', 'write', 'admin']).toContain(k.scope);
    }
  });

  it('已撤销的 key 改权限会被拒', async () => {
    const key = await createKey('write');
    const id = createdKeyIds[createdKeyIds.length - 1];

    const revoked = await http.acmeAdmin.delete(`/api-keys/${id}`, { validateStatus: () => true });
    expect(revoked.status).toBe(200);

    const patched = await http.acmeAdmin.patch(
      `/api-keys/${id}`,
      { scope: 'read' },
      { validateStatus: () => true },
    );
    expect(patched.status).toBe(400);
  });
});
