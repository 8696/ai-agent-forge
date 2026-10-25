/**
 * tests/integration/tool-calling-e2e.test.ts
 * 对应 src/services/chat.ts 的工具循环（B3 工具调用）
 * 详见 docs/12-b-需求-ai对话能力.md §B3
 *
 * ⚠️ 本文件**会真的调 LLM 并联网，产生真实费用**。
 *    真调 LLM 的用例由 CHAT_LLM_E2E=1 控制，默认跳过。
 *
 * 前置：
 *   1. yarn migrate（tools 表 / messages.parts 列存在）
 *   2. 后端起在 3099（或用 API_BASE 指到别的端口）：NODE_ENV=test PORT=3099 tsx src/server.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { apiBase, allHttpFromTokensFile, readSse, textFromChunks, dataChunks, readTokensFile, type AllHttp } from '../helpers';
import type { ChatUIMessage } from '@shared/types/chat';

const BASE = apiBase();
const LLM_E2E = process.env.CHAT_LLM_E2E === '1';
const LLM_TIMEOUT = 240_000;

interface ToolCallData {
  tool_call_id: string;
  tool_name: string;
  builtin: string;
  args: unknown;
  status: 'ok' | 'error' | 'timeout' | 'awaiting_confirmation';
  output: unknown;
  error: string | null;
  duration_ms: number;
  confirm_hint?: string;
}

/** AI SDK 发给服务端的请求体形状（HttpChatTransport 协议） */
function chatBody(userText: string): { messages: ChatUIMessage[] } {
  return {
    messages: [
      { id: `local-${Date.now()}`, role: 'user', parts: [{ type: 'text', text: userText }] },
    ],
  };
}

describe('工具调用 · 端到端（真实 LLM 调用，产生费用）', () => {
  let http: AllHttp;
  let token: string;
  const createdToolIds: string[] = [];
  /** 这轮注册过的工具名（afterAll 用来清工具调用流水） */
  const createdToolNames: string[] = [];
  const createdSessionIds: string[] = [];

  beforeAll(async () => {
    http = await allHttpFromTokensFile();
    token = (await readTokensFile()).acmeCustomer;
  });

  afterAll(async () => {
    for (const id of createdToolIds) {
      await http.acmeAdmin.delete(`/tools/${id}`, { validateStatus: () => true });
    }
    // 工具调用流水也清一下 —— 跑一次 E2E 会攒十几行，别把开发库堆满
    const { ToolCallLog } = await import('../../src/models');
    for (const name of createdToolNames) {
      await ToolCallLog.destroy({ where: { tool_name: name } });
    }
    for (const id of createdSessionIds) {
      await http.acmeCustomer.delete(`/sessions/${id}`, { validateStatus: () => true });
    }
  });

  /** 注册一个工具，返回它的 id */
  const register = async (name: string, builtin: string, body: Record<string, unknown> = {}) => {
    const r = await http.acmeAdmin.post(
      '/tools',
      { name, type: 'builtin', builtin, ...body },
      { validateStatus: () => true },
    );
    expect(r.status).toBe(201);
    const id = (r.data as { tool: { id: string } }).tool.id;
    createdToolIds.push(id);
    createdToolNames.push(name);
    return id;
  };

  describe.skipIf(!LLM_E2E)('工具真的被调用了', () => {
    it('模型调工具 → 结果回灌 → 回答里带上工具返回的真实数据', async () => {
      const toolName = `query_order_${Date.now()}`;
      // ⚠️ **不传 description** —— 用内置实现的默认描述。
      // 描述是模型判断「要不要调这个工具」的唯一依据，测试必须跑真实的那一版。
      await register(toolName, 'query_order_status');

      const created = await http.acmeCustomer.post<{ id: string }>('/sessions');
      createdSessionIds.push(created.data.id);
      const id = created.data.id;

      const r = await readSse(
        `${BASE}/api/v1/customer/sessions/${id}/messages`,
        token,
        chatBody('帮我查一下订单 SO-2026-0001 到哪了？'),
      );
      expect(r.status).toBe(200);

      // 1) 流里有工具调用记录
      const calls = dataChunks(r.chunks, 'tool-call') as ToolCallData[];
      expect(calls.length, '这一轮应该至少调了一次工具').toBeGreaterThan(0);
      const call = calls[0];
      expect(call?.tool_name).toBe(toolName);
      expect(call?.status).toBe('ok');
      expect(call?.args).toMatchObject({ order_no: 'SO-2026-0001' });

      // 2) 后台「工具调用记录」里能查到这一条（写入路径）
      const logs = await http.acmeAdmin.get('/tool-logs?page_size=20');
      expect(logs.status).toBe(200);
      const rows = (logs.data as { logs: Array<{ tool_name: string; status: string; args: unknown; output: unknown }> }).logs;
      const hit = rows.find((l) => l.tool_name === toolName);
      expect(hit, '工具调用记录里应该有这一条').toBeDefined();
      expect(hit?.status).toBe('ok');
      expect(hit?.args).toMatchObject({ order_no: 'SO-2026-0001' });
      expect(hit?.output).toBeDefined();

      // 3) 工具返回的数据出现在最终回答里（证明结果真的回灌了，不是模型编的）
      //    断言订单状态（每单都有）；运单号只在已发货的订单上有，有才断言
      const answer = textFromChunks(r.chunks);
      const output = call?.output as {
        status?: string;
        tracking_no?: string | null;
        carrier?: string | null;
      };
      expect(answer.length).toBeGreaterThan(0);
      expect(answer).toContain(output?.status ?? '');
      if (output?.tracking_no !== null && output?.tracking_no !== undefined) {
        expect(answer).toContain(output.tracking_no);
      }
    }, LLM_TIMEOUT);

    it('工具调用记录落库了（刷新页面后卡片还在）', async () => {
      // 用物流工具：问题里带具体运单号 + 「物流轨迹」，跟工具描述的触发场景完全对上，
      // 模型调它的概率很高 —— 「我有哪些券」这种问题模型有时会直接答，调不调看它心情。
      const toolName = `query_shipping_${Date.now()}`;
      await register(toolName, 'query_shipping_track');

      const created = await http.acmeCustomer.post<{ id: string }>('/sessions');
      createdSessionIds.push(created.data.id);
      const id = created.data.id;

      await readSse(
        `${BASE}/api/v1/customer/sessions/${id}/messages`,
        token,
        chatBody('运单号 SF1234567890 现在到哪了？给我看看物流轨迹'),
      );

      const history = await http.acmeCustomer.get<{ messages: ChatUIMessage[] }>(
        `/sessions/${id}/messages`,
      );
      const assistant = history.data.messages.find((m) => m.role === 'assistant');
      const parts = assistant?.parts ?? [];
      const toolParts = parts.filter((p) => p.type === 'data-tool-call');
      expect(toolParts.length, '工具调用记录应该落进 messages.parts').toBeGreaterThan(0);
    }, LLM_TIMEOUT);

    it('工具禁用后 → 模型不再调用它', async () => {
      const toolName = `query_docs_${Date.now()}`;
      const toolId = await register(toolName, 'list_knowledge_documents', {
        description: '列出本租户知识库里有哪些文档。当用户问「你们有哪些资料」时使用。',
      });
      await http.acmeAdmin.patch(`/tools/${toolId}`, { enabled: false });

      const created = await http.acmeCustomer.post<{ id: string }>('/sessions');
      createdSessionIds.push(created.data.id);
      const id = created.data.id;

      const r = await readSse(
        `${BASE}/api/v1/customer/sessions/${id}/messages`,
        token,
        chatBody('你们知识库里有哪些资料？'),
      );
      const calls = dataChunks(r.chunks, 'tool-call') as ToolCallData[];
      expect(calls.some((c) => c.tool_name === toolName)).toBe(false);
    }, LLM_TIMEOUT);
  });

  describe.skipIf(!LLM_E2E)('HITL · 敏感工具先要用户确认', () => {
    it('敏感工具不直接执行 → 返回 awaiting_confirmation → 确认后才执行', async () => {
      const toolName = `submit_refund_${Date.now()}`;
      await register(toolName, 'submit_refund_request', { requires_confirmation: true });

      const created = await http.acmeCustomer.post<{ id: string }>('/sessions');
      createdSessionIds.push(created.data.id);
      const id = created.data.id;

      // 第一轮：模型调工具 → 闸门拦下
      const r1 = await readSse(
        `${BASE}/api/v1/customer/sessions/${id}/messages`,
        token,
        chatBody('帮我给订单 SO-2026-0001 申请退款 199 块，理由是商品与描述不符'),
      );
      const calls1 = dataChunks(r1.chunks, 'tool-call') as ToolCallData[];
      expect(calls1.length).toBeGreaterThan(0);
      expect(calls1[0]?.status).toBe('awaiting_confirmation');
      expect(calls1[0]?.output).toBeNull();

      // 用户点「确认执行」→ 后端记下批准
      const args = calls1[0]?.args;
      const approval = await http.acmeCustomer.post(
        `/sessions/${id}/tool-approvals`,
        { tool_name: toolName, args },
        { validateStatus: () => true },
      );
      expect(approval.status).toBe(200);

      // 第二轮：模型用同样的参数再调 → 闸门放行 → 真正执行
      const history = await http.acmeCustomer.get<{ messages: ChatUIMessage[] }>(
        `/sessions/${id}/messages`,
      );
      const r2 = await readSse(`${BASE}/api/v1/customer/sessions/${id}/messages`, token, {
        messages: [
          ...history.data.messages,
          { id: 'u2', role: 'user', parts: [{ type: 'text', text: '确认执行' }] },
        ],
      });
      const calls2 = dataChunks(r2.chunks, 'tool-call') as ToolCallData[];
      const executed = calls2.find((c) => c.status === 'ok');
      expect(executed, '确认之后工具应该被真正执行').toBeDefined();
      expect((executed?.output as { refund_no?: string } | undefined)?.refund_no).toBeDefined();
    }, LLM_TIMEOUT);
  });
});
