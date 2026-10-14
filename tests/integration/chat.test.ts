/**
 * tests/integration/chat.test.ts
 * 对应 src/gateway/chat-routes.ts（1 个端点：POST /chat）
 * API Key 鉴权（对外）
 * 详见 docs/18-测试流程规范.md §18.3
 *
 * 注：业务正确性靠 test-step6.ts；本测试覆盖鉴权 + 入参校验。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import axios from 'axios';
import { allHttpFromTokensFile, type AllHttp } from '../helpers';

const BASE = `http://localhost:${process.env.PORT ?? '3000'}`;

describe('chat-routes (API Key)', () => {
  let http: AllHttp;

  beforeAll(async () => {
    http = await allHttpFromTokensFile();
  });

  describe('POST /api/v1/chat · 同步', () => {
    it('401 无 API Key', async () => {
      const r = await axios.post(
        `${BASE}/api/v1/chat`,
        { messages: [{ role: 'user', content: 'hi' }] },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(401);
    });

    it('401 用 JWT（不是 API Key）鉴权', async () => {
      const r = await axios.post(
        `${BASE}/api/v1/chat`,
        { messages: [{ role: 'user', content: 'hi' }] },
        {
          headers: {
            authorization: http.acmeAdmin.defaults.headers.authorization,
          },
          validateStatus: () => true,
        },
      );
      expect(r.status).toBe(401);
    });

    it('400 messages 为空数组', async () => {
      const r = await http.acmeApiKey.post('/chat', { messages: [] }, { validateStatus: () => true });
      expect(r.status).toBe(400);
    });

    it('400 role 非法值', async () => {
      const r = await http.acmeApiKey.post(
        '/chat',
        { messages: [{ role: 'assistant-and-user', content: 'x' }] },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(400);
    });
  });
});
