/**
 * tests/integration/active-config.test.ts
 * 对应 src/gateway/active-config-routes.ts（1 个端点）
 * 详见 docs/18-测试流程规范.md §18.3
 */
import { describe, it, expect } from 'vitest';
import axios from 'axios';

const BASE = `http://localhost:${process.env.PORT ?? '3099'}`;

describe('active-config-routes', () => {
  describe('GET /api/v1/active-config', () => {
    it('200 + 当前激活 LLM/Embedding 配置', async () => {
      const r = await axios.get(`${BASE}/api/v1/active-config`, { validateStatus: () => true });
      expect(r.status).toBe(200);
      // 响应字段：provider / llmModel / embedModel / embedDimensions
      const data = r.data as Record<string, unknown>;
      expect(data).toHaveProperty('provider');
      expect(data).toHaveProperty('llmModel');
      expect(data).toHaveProperty('embedModel');
      expect(data).toHaveProperty('embedDimensions');
    });

    it('200 不需鉴权（公开端点）', async () => {
      // 不带 Authorization 头应该照样 200
      const r = await axios.get(`${BASE}/api/v1/active-config`, { validateStatus: () => true });
      expect(r.status).toBe(200);
    });
  });
});
