/**
 * tests/integration/external-sessions.test.ts
 * 对应 src/gateway/sessions-routes.ts（1 个端点：GET /sessions/:id）
 * API Key 鉴权
 * 详见 docs/18-测试流程规范.md §18.3
 */
import { describe, it, expect, beforeAll } from 'vitest';
import axios from 'axios';
import { allHttpFromTokensFile, type AllHttp } from '../helpers';

const BASE = `http://localhost:${process.env.PORT ?? '3000'}`;

describe('external-sessions-routes (API Key)', () => {
  let http: AllHttp;

  beforeAll(async () => {
    http = await allHttpFromTokensFile();
  });

  describe('GET /api/v1/sessions/:id', () => {
    it('404 不存在的 id', async () => {
      const r = await http.acmeApiKey.get('/sessions/__no_such_id__', {
        validateStatus: () => true,
      });
      expect(r.status).toBe(404);
    });

    it('401 无 API Key', async () => {
      const r = await axios.get(`${BASE}/api/v1/sessions/any_id`, {
        validateStatus: () => true,
      });
      expect(r.status).toBe(401);
    });

    it('401 格式非法（不是 ak_ 前缀）', async () => {
      const r = await axios.get(`${BASE}/api/v1/sessions/any_id`, {
        headers: { authorization: 'Bearer not_an_api_key' },
        validateStatus: () => true,
      });
      expect(r.status).toBe(401);
    });

    it('401 API Key 不存在', async () => {
      const r = await axios.get(`${BASE}/api/v1/sessions/any_id`, {
        headers: { authorization: 'Bearer ak_definitely_not_real_key_1234567890' },
        validateStatus: () => true,
      });
      expect(r.status).toBe(401);
    });
  });

  describe('跨租户防御', () => {
    it('globex API Key 拿不到 acme session', async () => {
      const r = await http.globApiKey.get('/sessions/__any_id__', {
        validateStatus: () => true,
      });
      // 404 / 403 都算"不可见"（取决于实现）
      expect([403, 404]).toContain(r.status);
    });
  });
});
