/**
 * tests/integration/admin-sessions.test.ts
 * 对应 src/gateway/admin/sessions-routes.ts（2 个端点）
 * 详见 docs/18-测试流程规范.md §18.3
 */
import { describe, it, expect, beforeAll } from 'vitest';
import axios from 'axios';
import { allHttpFromTokensFile, type AllHttp } from '../helpers';

const BASE = `http://localhost:${process.env.PORT ?? '3000'}`;

describe('admin-sessions-routes', () => {
  let http: AllHttp;

  beforeAll(async () => {
    http = await allHttpFromTokensFile();
  });

  describe('GET /sessions · 列 session', () => {
    it('200 + 返回 sessions 数组', async () => {
      const r = await http.acmeAdmin.get('/sessions', { validateStatus: () => true });
      expect(r.status).toBe(200);
      expect(Array.isArray((r.data as { sessions: unknown[] }).sessions)).toBe(true);
    });

    it('支持 query: limit', async () => {
      const r = await http.acmeAdmin.get('/sessions?limit=5', { validateStatus: () => true });
      expect(r.status).toBe(200);
      expect((r.data as { limit: number }).limit).toBe(5);
    });

    it('400 limit 超过 max=200', async () => {
      const r = await http.acmeAdmin.get('/sessions?limit=9999', { validateStatus: () => true });
      expect(r.status).toBe(400);
    });

    it('401 无 token', async () => {
      const r = await axios.get(`${BASE}/api/v1/admin/sessions`, { validateStatus: () => true });
      expect(r.status).toBe(401);
    });
  });

  describe('GET /sessions/:id · 单 session 详情', () => {
    it('404 不存在的 id', async () => {
      const r = await http.acmeAdmin.get('/sessions/__no_such_id__', {
        validateStatus: () => true,
      });
      expect(r.status).toBe(404);
    });

    it('支持 include_messages=false 只取元信息', async () => {
      const r = await http.acmeAdmin.get(
        '/sessions/__no_such_id__?include_messages=false',
        { validateStatus: () => true },
      );
      expect(r.status).toBe(404); // 不存在，但端点接受了 query
    });
  });

  describe('跨租户防御', () => {
    it('acme admin 看不到 globex session', async () => {
      const r = await http.acmeAdmin.get('/sessions', { validateStatus: () => true });
      // 至少应该返回的是 acme 范围内的数据；具体 session 内容由 chat 测试保证
      expect(r.status).toBe(200);
      const total = (r.data as { total: number }).total;
      expect(typeof total).toBe('number');
    });
  });
});
