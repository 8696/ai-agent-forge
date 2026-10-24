/**
 * tests/integration/dev-probe.test.ts
 * 对应 src/gateway/dev-probe-routes.ts（1 个端点：GET /api/_dev/jwt-info）
 * 详见 docs/18-测试流程规范.md §18.3
 *
 * （/probe/llm 端点已删除 —— LLM 不再被后端使用）
 */
import { describe, it, expect } from 'vitest';
import axios from 'axios';
import { apiBase,  allHttpFromTokensFile } from '../helpers';

const BASE = apiBase();

describe('dev-probe-routes', () => {
  describe('GET /api/_dev/jwt-info', () => {
    it('400 缺 Authorization', async () => {
      const r = await axios.get(`${BASE}/api/_dev/jwt-info`, { validateStatus: () => true });
      expect(r.status).toBe(400);
    });

    it('200 + 解码 admin JWT 拿到 payload', async () => {
      const http = await allHttpFromTokensFile();
      const r = await axios.get(`${BASE}/api/_dev/jwt-info`, {
        headers: { authorization: http.acmeAdmin.defaults.headers.authorization },
        validateStatus: () => true,
      });
      expect(r.status).toBe(200);
      const body = r.data as { ok: boolean; payload: { role: string; tenant_id: string } };
      expect(body.ok).toBe(true);
      expect(body.payload.role).toBe('admin');
      expect(body.payload.tenant_id).toBeTruthy();
    });

    it('200 篡改 token → ok=false', async () => {
      const http = await allHttpFromTokensFile();
      const token = (http.acmeAdmin.defaults.headers.authorization as string | undefined)?.replace(/^Bearer\s+/, '') ?? '';
      const parts = token.split('.');
      const tampered = `${parts[0]}.${parts[1]}.invalid-sig`;
      const r = await axios.get(`${BASE}/api/_dev/jwt-info`, {
        headers: { authorization: `Bearer ${tampered}` },
        validateStatus: () => true,
      });
      expect(r.status).toBe(200);
      expect((r.data as { ok: boolean }).ok).toBe(false);
    });
  });
});
