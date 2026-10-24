/**
 * E1 · 对外接入的集成测试
 *
 * 覆盖两条新链路：
 *   1. **公开挂件**（/api/v1/public/widget/*，免登录，匿名会话 token）
 *   2. **对外 REST API**（/api/v1/public/*，API Key 鉴权）
 *   3. **API Key 管理**（/api/v1/admin/api-keys，admin JWT）
 *
 * 前置条件（与其它集成测试一样）：
 *   1. yarn migrate
 *   2. 后端起在 3099：NODE_ENV=test PORT=3099 tsx src/server.ts
 *   3. （vitest 的 globalSetup 会自动 yarn seed + yarn e2e:login）
 *
 * ⚠️ 本文件**不调 LLM**：所有用例都在「鉴权 / 参数校验 / 会话归属」这一层就返回了，
 *    零费用。真调 LLM 的用例由 CHAT_LLM_E2E=1 控制，默认跳过。
 */
import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import axios from 'axios';
import { allHttpFromTokensFile, readTokensFile, type AllHttp } from '../helpers';
import { getSequelize } from '../../src/db';
import { ApiKey, Session } from '../../src/models';
import { signWidgetToken, verifyWidgetToken } from '../../src/gateway/public/widget-token';

function base(): string {
  return process.env.API_BASE ?? `http://localhost:${process.env.PORT ?? '3099'}`;
}

/** 什么都返回、不抛的 axios（方便断言 4xx 的状态码） */
function loose(): ReturnType<typeof axios.create> {
  return axios.create({ baseURL: base(), validateStatus: () => true });
}

const LLM_E2E = process.env.CHAT_LLM_E2E === '1';

describe('E1 · 公开挂件 + 对外 REST API', () => {
  let http: AllHttp;
  let acmeApiKey: string;
  let globApiKey: string;
  let acmeAdminToken: string;
  let acmeCustomerToken: string;
  let systemToken: string;

  /** 本次测试建的会话 / key，afterAll 清理 */
  const createdSessionIds: string[] = [];
  const createdKeyIds: string[] = [];

  beforeAll(async () => {
    getSequelize();
    http = await allHttpFromTokensFile();
    const tokens = await readTokensFile();
    acmeApiKey = tokens.acmeApiKey;
    globApiKey = tokens.globApiKey;
    acmeAdminToken = tokens.acmeAdmin;
    acmeCustomerToken = tokens.acmeCustomer;
    systemToken = tokens.system;
  });

  afterAll(async () => {
    for (const id of createdSessionIds) {
      await Session.destroy({ where: { id } });
    }
    for (const id of createdKeyIds) {
      await ApiKey.destroy({ where: { id } });
    }
  });

  // ==========================================================
  // 公开挂件（免登录）
  // ==========================================================

  describe('挂件 · 租户信息', () => {
    it('GET /info → 200，带租户名', async () => {
      const r = await loose().get('/api/v1/public/widget/acme/info');
      expect(r.status).toBe(200);
      expect(r.data.tenant_code).toBe('acme');
      expect(typeof r.data.tenant_name).toBe('string');
      expect(r.data.tenant_name.length).toBeGreaterThan(0);
    });

    it('GET /info · 不存在的租户 → 404', async () => {
      const r = await loose().get('/api/v1/public/widget/no-such-tenant/info');
      expect(r.status).toBe(404);
    });
  });

  describe('挂件 · 匿名会话', () => {
    it('POST /sessions → 201，返回 session_id + token', async () => {
      const r = await loose().post('/api/v1/public/widget/acme/sessions', {});
      expect(r.status).toBe(201);
      expect(typeof r.data.session_id).toBe('string');
      expect(typeof r.data.token).toBe('string');
      createdSessionIds.push(r.data.session_id as string);
    });

    it('落库口径：channel=widget 且 user_id 为空（匿名）', async () => {
      const r = await loose().post('/api/v1/public/widget/acme/sessions', {});
      expect(r.status).toBe(201);
      const id = r.data.session_id as string;
      createdSessionIds.push(id);

      const row = await Session.findByPk(id);
      expect(row).not.toBeNull();
      expect(row?.channel).toBe('widget');
      expect(row?.user_id).toBeNull();
      expect(row?.tenant_id).not.toBeNull();
    });

    it('token 里解出来的就是刚建的会话 id（匿名会话靠它认领）', async () => {
      const r = await loose().post('/api/v1/public/widget/acme/sessions', {});
      const token = r.data.token as string;
      const sid = verifyWidgetToken(token);
      expect(sid).toBe(r.data.session_id);
    });

    it('GET /session · 凭 token 能恢复会话（历史还在）', async () => {
      const created = await loose().post('/api/v1/public/widget/acme/sessions', {});
      const sid = created.data.session_id as string;
      const token = created.data.token as string;
      createdSessionIds.push(sid);

      const r = await loose().get('/api/v1/public/widget/acme/session', {
        headers: { 'x-widget-token': token },
      });
      expect(r.status).toBe(200);
      expect(r.data.session_id).toBe(sid);
      expect(Array.isArray(r.data.messages)).toBe(true);
      expect(r.data.messages).toHaveLength(0);
    });

    it('GET /session · token 是瞎编的 → 404', async () => {
      const r = await loose().get('/api/v1/public/widget/acme/session', {
        headers: { 'x-widget-token': 'w1.abc.def' },
      });
      expect(r.status).toBe(404);
    });

    it('GET /session · 不带 token → 404', async () => {
      const r = await loose().get('/api/v1/public/widget/acme/session');
      expect(r.status).toBe(404);
    });

    it('跨租户隔离：acme 的 token 拿到 globex 的 URL 上 → 404', async () => {
      const created = await loose().post('/api/v1/public/widget/acme/sessions', {});
      createdSessionIds.push(created.data.session_id as string);

      const r = await loose().get('/api/v1/public/widget/globex/session', {
        headers: { 'x-widget-token': created.data.token as string },
      });
      expect(r.status).toBe(404);
    });

    it('别人的会话 id 伪造不出 token（token 签名对不上 → 404）', async () => {
      const created = await loose().post('/api/v1/public/widget/acme/sessions', {});
      const sid = created.data.session_id as string;
      createdSessionIds.push(sid);

      // 只知道会话 id、拿不到签名 → 造一个 token 也认领不了
      const forged = `w1.${sid}.${'A'.repeat(43)}`;
      const r = await loose().get('/api/v1/public/widget/acme/session', {
        headers: { 'x-widget-token': forged },
      });
      expect(r.status).toBe(404);
    });

    it('POST /messages · 不带 token → 404（不会给匿名会话开流）', async () => {
      const r = await loose().post('/api/v1/public/widget/acme/messages', {
        messages: [{ id: 'x', role: 'user', parts: [{ type: 'text', text: '你好' }] }],
      });
      expect(r.status).toBe(404);
    });

    it('session_id 直接当凭证是不行的（签名校验挡住）', async () => {
      const created = await loose().post('/api/v1/public/widget/acme/sessions', {});
      createdSessionIds.push(created.data.session_id as string);
      const r = await loose().get('/api/v1/public/widget/acme/session', {
        headers: { 'x-widget-token': created.data.session_id as string },
      });
      expect(r.status).toBe(404);
    });
  });

  // ==========================================================
  // 对外 REST API（API Key 鉴权）
  // ==========================================================

  describe('对外 API · 鉴权', () => {
    it('不带 key → 401', async () => {
      const r = await loose().post('/api/v1/public/chat', { question: '你好' });
      expect(r.status).toBe(401);
    });

    it('key 是瞎编的 → 401', async () => {
      const r = await loose().post('/api/v1/public/chat', { question: '你好' }, {
        headers: { authorization: 'Bearer ak_totally-made-up-key-value' },
      });
      expect(r.status).toBe(401);
    });

    it('拿 customer 的 JWT 当 key → 401（鉴权命名空间不互通）', async () => {
      const r = await loose().post('/api/v1/public/chat', { question: '你好' }, {
        headers: { authorization: `Bearer ${acmeCustomerToken}` },
      });
      expect(r.status).toBe(401);
    });

    it('有效的 key + 空问题 → 400（走到参数校验，说明鉴权已过）', async () => {
      const r = await loose().post('/api/v1/public/chat', { question: '' }, {
        headers: { authorization: `Bearer ${acmeApiKey}` },
      });
      expect(r.status).toBe(400);
    });

    it('有效的 key + 缺 question 字段 → 400', async () => {
      const r = await loose().post('/api/v1/public/chat', {}, {
        headers: { authorization: `Bearer ${acmeApiKey}` },
      });
      expect(r.status).toBe(400);
    });

    it('X-API-Key 头也认', async () => {
      const r = await loose().post('/api/v1/public/chat', { question: '' }, {
        headers: { 'x-api-key': acmeApiKey },
      });
      expect(r.status).toBe(400);
    });

    it('globex 的 key 不能用 acme 的会话（会话 id 跨租户 → 404）', async () => {
      const r = await loose().post('/api/v1/public/chat', {
        question: '你好',
        session_id: 'session-of-another-tenant',
      }, {
        headers: { authorization: `Bearer ${globApiKey}` },
      });
      expect(r.status).toBe(404);
    });

    it.skipIf(!LLM_E2E)('真调 LLM：有效 key 能拿到回答（CHAT_LLM_E2E=1 才跑）', async () => {
      const r = await loose().post('/api/v1/public/chat', { question: '你好，请简单自我介绍' }, {
        headers: { authorization: `Bearer ${acmeApiKey}` },
        timeout: 60_000,
      });
      expect(r.status).toBe(200);
      expect(typeof r.data.answer).toBe('string');
      expect(typeof r.data.session_id).toBe('string');
    });
  });

  // ==========================================================
  // API Key 管理（admin JWT）
  // ==========================================================

  describe('API Key 管理', () => {
    it('admin 建一把 key → 201，完整 key 只在这次响应里出现', async () => {
      const r = await loose().post('/api/v1/admin/api-keys', { name: `e1-test-${Date.now()}` }, {
        headers: { authorization: `Bearer ${acmeAdminToken}` },
      });
      expect(r.status).toBe(201);
      expect(typeof r.data.api_key).toBe('string');
      expect(r.data.api_key.startsWith('ak_')).toBe(true);
      expect(r.data.key_prefix).toBe(r.data.api_key.slice(0, 8));
      createdKeyIds.push(r.data.id as string);
    });

    it('新建的 key 立刻能用（拿它调对外 API → 过鉴权）', async () => {
      const created = await loose().post('/api/v1/admin/api-keys', { name: `e1-use-${Date.now()}` }, {
        headers: { authorization: `Bearer ${acmeAdminToken}` },
      });
      createdKeyIds.push(created.data.id as string);

      const r = await loose().post('/api/v1/public/chat', { question: '' }, {
        headers: { authorization: `Bearer ${created.data.api_key as string}` },
      });
      // 400 = 参数没过，但鉴权已经过了（401 才是鉴权没过）
      expect(r.status).toBe(400);
    });

    it('列表里能看到这把 key，但**看不到完整 key 和 hash**', async () => {
      const created = await loose().post('/api/v1/admin/api-keys', { name: `e1-list-${Date.now()}` }, {
        headers: { authorization: `Bearer ${acmeAdminToken}` },
      });
      createdKeyIds.push(created.data.id as string);

      const r = await loose().get('/api/v1/admin/api-keys', {
        headers: { authorization: `Bearer ${acmeAdminToken}` },
      });
      expect(r.status).toBe(200);
      const found = (r.data.keys as Array<Record<string, unknown>>).find(
        (k) => k['id'] === created.data.id,
      );
      expect(found).toBeDefined();
      expect(found?.['key_prefix']).toBe(created.data.key_prefix);
      expect(found?.['api_key']).toBeUndefined();
      expect(found?.['key_hash']).toBeUndefined();
    });

    it('撤销后立刻失效（鉴权缓存同时被清掉）', async () => {
      const created = await loose().post('/api/v1/admin/api-keys', { name: `e1-revoke-${Date.now()}` }, {
        headers: { authorization: `Bearer ${acmeAdminToken}` },
      });
      const id = created.data.id as string;
      const raw = created.data.api_key as string;
      createdKeyIds.push(id);

      // 先用一次，让它进鉴权缓存
      const before = await loose().post('/api/v1/public/chat', { question: '' }, {
        headers: { authorization: `Bearer ${raw}` },
      });
      expect(before.status).toBe(400);

      const revoked = await loose().delete(`/api/v1/admin/api-keys/${id}`, {
        headers: { authorization: `Bearer ${acmeAdminToken}` },
      });
      expect(revoked.status).toBe(200);
      expect(revoked.data.revoked_at).not.toBeNull();

      const after = await loose().post('/api/v1/public/chat', { question: '' }, {
        headers: { authorization: `Bearer ${raw}` },
      });
      expect(after.status).toBe(401);
    });

    it('customer 的 JWT 不能调 admin 的 API Key 管理 → 401', async () => {
      const r = await loose().get('/api/v1/admin/api-keys', {
        headers: { authorization: `Bearer ${acmeCustomerToken}` },
      });
      expect(r.status).toBe(401);
    });

    it('system 的 JWT 也不能调（admin 桶只放 admin 角色）→ 401', async () => {
      const r = await loose().get('/api/v1/admin/api-keys', {
        headers: { authorization: `Bearer ${systemToken}` },
      });
      expect(r.status).toBe(401);
    });

    it('不带 token → 401', async () => {
      const r = await loose().get('/api/v1/admin/api-keys');
      expect(r.status).toBe(401);
    });
  });

  // ==========================================================
  // 两个对外子系统之间的隔离
  // ==========================================================

  describe('对外子系统之间的隔离', () => {
    it('挂件的匿名 token 不能当 API Key 用', async () => {
      const created = await loose().post('/api/v1/public/widget/acme/sessions', {});
      createdSessionIds.push(created.data.session_id as string);

      const r = await loose().post('/api/v1/public/chat', { question: '' }, {
        headers: { authorization: `Bearer ${created.data.token as string}` },
      });
      expect(r.status).toBe(401);
    });

    it('API Key 不能当挂件的匿名 token 用', async () => {
      const r = await loose().get('/api/v1/public/widget/acme/session', {
        headers: { 'x-widget-token': acmeApiKey },
      });
      expect(r.status).toBe(404);
    });
  });
});
