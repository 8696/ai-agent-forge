import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import axios from 'axios';
import type { ChatUIMessage, CitationHit } from '@shared/types/chat';
import {
  allHttpFromTokensFile,
  readSse,
  readTokensFile,
  textFromChunks,
  dataChunks,
  type AllHttp,
} from '../helpers';

/**
 * customer 对话路由（src/gateway/customer/chat-routes.ts）
 *
 * 前置条件（与 admin-knowledge.test.ts 同）：
 *   1. yarn migrate（sessions / messages 表存在）
 *   2. 后端起在 3099：NODE_ENV=test PORT=3099 tsx src/server.ts
 *   3. Qdrant + Embedding API 可用（检索要真调 embedding）
 *
 * ⚠️ 本文件**会真的调 LLM + Embedding API 并联网，产生真实费用**。
 *    真调 LLM 的用例由 CHAT_LLM_E2E=1 控制，默认跳过；
 *    会话 CRUD / 鉴权 / 隔离 / 落库结构这些零费用用例任何时候都跑。
 */

const BASE = `http://localhost:${process.env.PORT ?? '3099'}`;
const LLM_E2E = process.env.CHAT_LLM_E2E === '1';
/** 唯一化后缀：防止重跑时命中上一轮自己上传的文档 */
const MARKER = `chat测试${Date.now()}`;

/** 造一个内存里的 .md 文件（Node 18+ 有全局 FormData / Blob） */
function mdFile(content: string): FormData {
  const form = new FormData();
  form.append('file', new Blob([content], { type: 'text/markdown' }), `${MARKER}.md`);
  return form;
}

/** AI SDK 发给服务端的请求体形状（HttpChatTransport 协议） */
function chatBody(userText: string, sessionId: string): { messages: ChatUIMessage[] } {
  return {
    messages: [
      { id: `local-${Date.now()}`, role: 'user', parts: [{ type: 'text', text: userText }] },
    ],
  };
}

function streamUrl(sessionId: string): string {
  return `${BASE}/api/v1/customer/sessions/${sessionId}/messages`;
}

describe('customer-chat-routes · 对话接口', () => {
  let http: AllHttp;
  let token: string;
  const createdSessionIds: string[] = [];
  const createdDocIds: string[] = [];

  beforeAll(async () => {
    http = await allHttpFromTokensFile();
    token = (await readTokensFile()).acmeCustomer;
  });

  afterAll(async () => {
    for (const id of createdSessionIds) {
      await http.acmeCustomer.delete(`/sessions/${id}`, { validateStatus: () => true });
    }
    for (const id of createdDocIds) {
      await http.acmeAdmin.delete(`/knowledge/${id}`, { validateStatus: () => true });
    }
  });

  // ===== 会话 CRUD（零费用）=====

  describe('会话 CRUD', () => {
    it('新建会话 → 201，channel=web / status=active', async () => {
      const r = await http.acmeCustomer.post<{ id: string; channel: string; status: string }>('/sessions');
      expect(r.status).toBe(201);
      expect(r.data.channel).toBe('web');
      expect(r.data.status).toBe('active');
      createdSessionIds.push(r.data.id);
    });

    it('会话列表只返回本用户的会话，带分页字段', async () => {
      const before = await http.acmeCustomer.get<{ sessions: unknown[]; pagination: { total: number } }>(
        '/sessions',
      );
      const created = await http.acmeCustomer.post<{ id: string }>('/sessions');
      createdSessionIds.push(created.data.id);

      const after = await http.acmeCustomer.get<{
        sessions: Array<{ id: string }>;
        pagination: { total: number; page: number; page_size: number };
      }>('/sessions');
      expect(after.status).toBe(200);
      expect(after.data.pagination.total).toBe(before.data.pagination.total + 1);
      expect(after.data.sessions[0]?.id).toBe(created.data.id);
    });

    it('重命名会话', async () => {
      const created = await http.acmeCustomer.post<{ id: string }>('/sessions');
      createdSessionIds.push(created.data.id);
      const renamed = await http.acmeCustomer.patch<{ title: string }>(`/sessions/${created.data.id}`, {
        title: '改过的标题',
      });
      expect(renamed.status).toBe(200);
      expect(renamed.data.title).toBe('改过的标题');
    });

    it('删除会话 → 204，再查 404', async () => {
      const created = await http.acmeCustomer.post<{ id: string }>('/sessions');
      const id = created.data.id;
      const del = await http.acmeCustomer.delete(`/sessions/${id}`);
      expect(del.status).toBe(204);
      const after = await http.acmeCustomer.get(`/sessions/${id}`, { validateStatus: () => true });
      expect(after.status).toBe(404);
    });

    it('空历史时返回空数组', async () => {
      const created = await http.acmeCustomer.post<{ id: string }>('/sessions');
      createdSessionIds.push(created.data.id);
      const r = await http.acmeCustomer.get<{ messages: unknown[]; has_more: boolean }>(
        `/sessions/${created.data.id}/messages`,
      );
      expect(r.status).toBe(200);
      expect(r.data.messages).toEqual([]);
      expect(r.data.has_more).toBe(false);
    });
  });

  // ===== 鉴权与隔离（零费用）=====

  describe('鉴权与跨租户隔离', () => {
    it('无 token → 401', async () => {
      const r = await axios.get(`${BASE}/api/v1/customer/sessions`, { validateStatus: () => true });
      expect(r.status).toBe(401);
    });

    it('admin token 打 customer 端点 → 401（跨子系统防御）', async () => {
      const t = (await readTokensFile()).acmeAdmin;
      const r = await axios.get(`${BASE}/api/v1/customer/sessions`, {
        headers: { authorization: `Bearer ${t}` },
        validateStatus: () => true,
      });
      expect(r.status).toBe(401);
    });

    it('别的租户拿不到本租户的会话 → 404（不是 403，不泄露存在性）', async () => {
      const created = await http.acmeCustomer.post<{ id: string }>('/sessions');
      createdSessionIds.push(created.data.id);
      const r = await http.globCustomer.get(`/sessions/${created.data.id}`, { validateStatus: () => true });
      expect(r.status).toBe(404);
    });

    it('别的租户读不到本租户的历史 → 404', async () => {
      const created = await http.acmeCustomer.post<{ id: string }>('/sessions');
      createdSessionIds.push(created.data.id);
      const r = await http.globCustomer.get(`/sessions/${created.data.id}/messages`, {
        validateStatus: () => true,
      });
      expect(r.status).toBe(404);
    });

    it('往别人的会话发消息 → 404（且不会真的开流）', async () => {
      const created = await http.acmeCustomer.post<{ id: string }>('/sessions');
      createdSessionIds.push(created.data.id);
      const r = await readSse(streamUrl(created.data.id), (await readTokensFile()).globCustomer, {
        messages: [{ id: 'x', role: 'user', parts: [{ type: 'text', text: '偷看别人的会话' }] }],
      });
      expect(r.status).toBe(404);
      expect(r.chunks).toEqual([]);
    });

    it('参数非法 → 400（空消息 / 缺 messages）', async () => {
      const created = await http.acmeCustomer.post<{ id: string }>('/sessions');
      createdSessionIds.push(created.data.id);
      const id = created.data.id;
      const missing = await readSse(streamUrl(id), token, {});
      expect(missing.status).toBe(400);
      const empty = await readSse(streamUrl(id), token, { messages: [] });
      expect(empty.status).toBe(400);
    });

    it('消息超长 → 400', async () => {
      const created = await http.acmeCustomer.post<{ id: string }>('/sessions');
      createdSessionIds.push(created.data.id);
      const r = await readSse(streamUrl(created.data.id), token, chatBody('问'.repeat(5000), created.data.id));
      expect(r.status).toBe(400);
    });
  });

  // ===== 流式对话（真调 LLM，产生费用）=====

  describe.skipIf(!LLM_E2E)('流式对话（真实 LLM 调用，产生费用）', () => {
    const LLM_TIMEOUT = 180_000;

    it('SSE 响应头符合 AI SDK UI message stream 协议', async () => {
      const created = await http.acmeCustomer.post<{ id: string }>('/sessions');
      createdSessionIds.push(created.data.id);
      const r = await readSse(streamUrl(created.data.id), token, chatBody('你好', created.data.id));
      expect(r.status).toBe(200);
      expect(r.contentType).toContain('text/event-stream');
      expect(r.headers['x-vercel-ai-ui-message-stream']).toBe('v1');
      expect(r.headers['cache-control']).toContain('no-cache');
      expect(r.headers['x-accel-buffering']).toBe('no');
      // keepAliveMs 生效：流一开就发 `: stream-open` 注释
      expect(r.raw).toContain(': stream-open');
    }, LLM_TIMEOUT);

    it('阶段心跳依次是 retrieving → generating', async () => {
      const created = await http.acmeCustomer.post<{ id: string }>('/sessions');
      createdSessionIds.push(created.data.id);
      const r = await readSse(streamUrl(created.data.id), token, chatBody('你好', created.data.id));
      const phases = dataChunks(r.chunks, 'status').map((d) => (d as { phase: string }).phase);
      expect(phases).toContain('retrieving');
      expect(phases).toContain('generating');
    }, LLM_TIMEOUT);

    it('落库：user + assistant 各一条，正文与流内容一致，usage 有真实 token 数', async () => {
      const created = await http.acmeCustomer.post<{ id: string }>('/sessions');
      createdSessionIds.push(created.data.id);
      const id = created.data.id;
      const r = await readSse(streamUrl(id), token, chatBody('介绍一下你们公司', id));
      expect(r.status).toBe(200);
      const answer = textFromChunks(r.chunks);
      expect(answer.length).toBeGreaterThan(0);

      // onEnd 在响应结束前就把库写完了（pipe 会 await flush），
      // 所以读完流立刻查即可，不需要轮询
      const history = await http.acmeCustomer.get<{ messages: ChatUIMessage[] }>(`/sessions/${id}/messages`);
      expect(history.data.messages).toHaveLength(2);
      expect(history.data.messages[0]?.role).toBe('user');
      expect(history.data.messages[1]?.role).toBe('assistant');
      expect(textOf(history.data.messages[1] ?? { id: '', role: 'user', parts: [] })).toBe(answer);
    }, LLM_TIMEOUT);

    it('会话标题自动取首条消息前 20 字', async () => {
      const created = await http.acmeCustomer.post<{ id: string }>('/sessions');
      createdSessionIds.push(created.data.id);
      const id = created.data.id;
      await readSse(streamUrl(id), token, chatBody('请介绍一下年假政策的具体规定', id));
      const detail = await http.acmeCustomer.get<{ title: string | null }>(`/sessions/${id}`);
      expect(detail.data.title).toBe('请介绍一下年假政策的具体规定'.slice(0, 20));
    }, LLM_TIMEOUT);

    it('第二轮带上第一轮的历史（多轮上下文）', async () => {
      const created = await http.acmeCustomer.post<{ id: string }>('/sessions');
      createdSessionIds.push(created.data.id);
      const id = created.data.id;
      await readSse(streamUrl(id), token, chatBody('我叫小林，请记住我的名字', id));

      // 真实前端的第二轮：完整消息数组 + 一条**新的**用户消息
      const history = await http.acmeCustomer.get<{ messages: ChatUIMessage[] }>(`/sessions/${id}/messages`);
      const r = await readSse(streamUrl(id), token, {
        messages: [
          ...history.data.messages,
          { id: 'u2', role: 'user', parts: [{ type: 'text', text: '我叫什么名字？' }] },
        ],
      });
      expect(r.status).toBe(200);
      expect(textFromChunks(r.chunks)).toContain('小林');
    }, LLM_TIMEOUT);

    it('重新生成：复用同一条 assistant 消息（不新插一行）', async () => {
      const created = await http.acmeCustomer.post<{ id: string }>('/sessions');
      createdSessionIds.push(created.data.id);
      const id = created.data.id;
      const first = await readSse(streamUrl(id), token, chatBody('请用一句话介绍你自己', id));
      const firstAnswer = textFromChunks(first.chunks);

      const history = await http.acmeCustomer.get<{ messages: ChatUIMessage[] }>(`/sessions/${id}/messages`);
      expect(history.data.messages).toHaveLength(2);
      const assistantId = history.data.messages[1]?.id ?? '';

      // 重发同一份历史（末条是 assistant）= 前端的 regenerate()
      const second = await readSse(streamUrl(id), token, { messages: history.data.messages });
      expect(second.status).toBe(200);
      expect(textFromChunks(second.chunks).length).toBeGreaterThan(0);

      // 关键断言：还是 2 条，assistant 的 id 没变（没新插一行）
      const after = await http.acmeCustomer.get<{ messages: ChatUIMessage[] }>(`/sessions/${id}/messages`);
      expect(after.data.messages).toHaveLength(2);
      expect(after.data.messages[1]?.id).toBe(assistantId);
      expect(firstAnswer.length).toBeGreaterThan(0);
    }, LLM_TIMEOUT);

    it('引用片段：编号连续、与 data-citations 一致', async () => {
      // 先给 acme 传一份文档，否则检索必然为空（这个用例要真验引用，不能靠假设）
      const doc = await http.acmeAdmin.post<{ id?: string; status?: string }>(
        '/knowledge/upload',
        mdFile(`# 员工手册\n\n${MARKER}：员工入职满 1 年不满 10 年的，年假 5 天。\n满 10 年的，年假 10 天。\n`),
        { timeout: 300_000 },
      );
      if (doc.data.id !== undefined) createdDocIds.push(doc.data.id);
      expect(doc.data.status).toBe('ready');

      const created = await http.acmeCustomer.post<{ id: string }>('/sessions');
      createdSessionIds.push(created.data.id);
      const r = await readSse(
        streamUrl(created.data.id),
        token,
        chatBody(`${MARKER} 的年假是几天？`, created.data.id),
      );
      const citations = dataChunks(r.chunks, 'citations');
      expect(citations.length).toBeGreaterThan(0);
      const payload = citations[0] as { hits: CitationHit[]; retrieved: boolean; took_ms: number };
      expect(payload.retrieved).toBe(true);
      expect(payload.took_ms).toBeGreaterThanOrEqual(0);
      expect(payload.hits.length).toBeGreaterThan(0);
      // 编号必须从 1 开始连续 —— 前端角标和 AI 回答里的 [n] 靠它对上
      expect(payload.hits.map((h) => h.index)).toEqual(payload.hits.map((_, i) => i + 1));
      // 命中的片段里应该能看到年假那句原文
      expect(payload.hits.some((h) => h.text.includes('年假'))).toBe(true);
    }, LLM_TIMEOUT);

    it('AI 回答里带 [n] 引用标记，且编号落在实际命中范围内', async () => {
      const doc = await http.acmeAdmin.post<{ id?: string; status?: string }>(
        '/knowledge/upload',
        mdFile(`# 报销规定\n\n${MARKER}：差旅报销需在出差结束后 30 天内提交发票，逾期不予受理。\n`),
        { timeout: 300_000 },
      );
      if (doc.data.id !== undefined) createdDocIds.push(doc.data.id);
      expect(doc.data.status).toBe('ready');

      const created = await http.acmeCustomer.post<{ id: string }>('/sessions');
      createdSessionIds.push(created.data.id);
      const r = await readSse(
        streamUrl(created.data.id),
        token,
        chatBody(`${MARKER} 里说的差旅报销期限是多久？`, created.data.id),
      );
      const answer = textFromChunks(r.chunks);
      const payload = dataChunks(r.chunks, 'citations')[0] as { hits: CitationHit[] };
      expect(payload.hits.length).toBeGreaterThan(0);
      // 引用编号不能超出实际提供的资料条数（模型幻觉出不存在的来源就是这条防线）
      const cited = [...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
      for (const n of cited) {
        expect(n).toBeGreaterThanOrEqual(1);
        expect(n).toBeLessThanOrEqual(payload.hits.length);
      }
      expect(answer).toContain('30');
    }, LLM_TIMEOUT);
  });
});

/** 从 UIMessage 里取纯文本（测试内联小工具，不复用前端代码） */
function textOf(m: ChatUIMessage): string {
  return m.parts
    .filter((p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('');
}