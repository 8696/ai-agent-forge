/**
 * tests/integration/chat-stream.test.ts
 * 对应 src/gateway/chat-stream-routes.ts（1 个端点：POST /chat/stream）
 * API Key 鉴权（对外）
 * 详见 docs/18-测试流程规范.md §18.3
 *
 * 注：业务正确性靠 test-step7.ts；本测试覆盖鉴权 + 入参校验。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import axios from 'axios';
import { allHttpFromTokensFile, type AllHttp } from '../helpers';

const BASE = `http://localhost:${process.env.PORT ?? '3000'}`;

describe('chat-stream-routes (API Key)', () => {
  let http: AllHttp;

  beforeAll(async () => {
    http = await allHttpFromTokensFile();
  });

  describe('POST /api/v1/chat/stream · SSE 流式', () => {
    it('401 无 API Key', async () => {
      const r = await axios.post(
        `${BASE}/api/v1/chat/stream`,
        { messages: [{ role: 'user', content: 'hi' }] },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(401);
    });

    it('400 messages 为空', async () => {
      const r = await http.acmeApiKey.post(
        '/chat/stream',
        { messages: [] },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(400);
    });

    it('400 temperature > 2', async () => {
      const r = await http.acmeApiKey.post(
        '/chat/stream',
        { messages: [{ role: 'user', content: 'hi' }], temperature: 3 },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(400);
    });

    it('400 max_tokens 超 8192', async () => {
      const r = await http.acmeApiKey.post(
        '/chat/stream',
        { messages: [{ role: 'user', content: 'hi' }], max_tokens: 9999 },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(400);
    });
  });
});
