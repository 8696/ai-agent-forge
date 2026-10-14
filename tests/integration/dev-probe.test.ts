/**
 * tests/integration/dev-probe.test.ts
 * 对应 src/gateway/dev-probe-routes.ts（1 个端点：POST /api/_dev/probe/llm）
 * 详见 docs/18-测试流程规范.md §18.3
 *
 * 注：这是 dev-only 端点（生产环境 404）；真实 LLM probe 由 scripts/probe.ts 覆盖。
 */
import { describe, it, expect } from 'vitest';
import axios from 'axios';

const BASE = `http://localhost:${process.env.PORT ?? '3000'}`;

describe('dev-probe-routes', () => {
  describe('POST /api/_dev/probe/llm', () => {
    it('400 body 非法', async () => {
      const r = await axios.post(
        `${BASE}/api/_dev/probe/llm`,
        { provider: 'unknown-provider' },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(400);
    });

    it('200 + 缺 body 时用默认 provider', async () => {
      // 端点通了就算过；LLM 真的能不能调通看 .env
      const r = await axios.post(
        `${BASE}/api/_dev/probe/llm`,
        {},
        {
          timeout: 60_000,
          validateStatus: () => true,
        },
      );
      // 200 = LLM 通；502 = LLM 失败但端点通；404 = 生产模式（端点不存在）
      // 测试环境期望 200 或 502，绝不能 400
      expect([200, 502]).toContain(r.status);
    });
  });
});
