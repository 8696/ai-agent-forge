/**
 * tests/integration/health.test.ts
 * 对应 src/gateway/health-routes.ts（1 个端点）
 * 详见 docs/12-d-需求-运维稳定.md §D6
 */
import { describe, it, expect } from 'vitest';
import axios from 'axios';
import { apiBase } from '../helpers';

const BASE = apiBase();

describe('health-routes', () => {
  describe('GET /health', () => {
    it('200 + ok', async () => {
      const r = await axios.get(`${BASE}/api/health`, { validateStatus: () => true });
      expect(r.status).toBe(200);
      expect((r.data as { ok: boolean }).ok).toBe(true);
    });
  });
});
