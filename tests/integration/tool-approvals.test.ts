/**
 * tests/integration/tool-approvals.test.ts
 * 对应 src/gateway/customer/chat-routes.ts 的 tool-approvals 端点 +
 *          src/gateway/public/widget-routes.ts 的挂件版（B3 HITL）
 * 详见 docs/12-b-需求-ai对话能力.md §B3
 */
import { describe, it, expect, beforeAll } from 'vitest';
import axios from 'axios';
import { apiBase, allHttpFromTokensFile, type AllHttp } from '../helpers';

const BASE = apiBase();

describe('tool-approvals · 敏感工具的人工确认', () => {
  let http: AllHttp;

  beforeAll(async () => {
    http = await allHttpFromTokensFile();
  });

  /** 建一个会话，返回 id */
  const newSession = async (client = http.acmeCustomer): Promise<string> => {
    const r = await client.post<{ id: string }>('/sessions');
    expect(r.status).toBe(201);
    return r.data.id;
  };

  describe('POST /sessions/:id/tool-approvals · 确认', () => {
    it('200 + 记录一条批准', async () => {
      const id = await newSession();
      const r = await http.acmeCustomer.post(
        `/sessions/${id}/tool-approvals`,
        { tool_name: 'submit_refund_request', args: { order_no: 'SO-1', amount: 199 } },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(200);
      const body = r.data as { ok: boolean; approval_key: string };
      expect(body.ok).toBe(true);
      expect(body.approval_key).toContain('submit_refund_request');
    });

    it('404 别人的会话', async () => {
      const id = await newSession();
      const r = await http.globCustomer.post(
        `/sessions/${id}/tool-approvals`,
        { tool_name: 'submit_refund_request', args: { order_no: 'SO-1' } },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(404);
    });
  });

  describe('批准真的落库了（回归测试）', () => {
    // ⚠️ **这个坑踩过**：批准记录是写进 `sessions.metadata`（JSON 列）的。
    //    之前是**原地改** `session.metadata` 这个对象 —— Sequelize 的 `set()` 看到
    //    「新值 === 旧值」（同一个引用）就认为没变，save() 时这一列压根不进 UPDATE，
    //    批准记录**静默丢掉**，闸门永远看不到批准，工具一直卡在「待确认」。
    //
    //    而且它**只在会话已经有 metadata 时才犯**（metadata 是 null 时
    //    `?? {}` 会造一个新对象，引用变了，反而能存进去）——
    //    所以新建的会话测不出来，挂件会话（带 client 信息）就必现。
    it('会话本来就有 metadata 时，批准也要写得进去', async () => {
      const { Session } = await import('../../src/models');
      const id = await newSession();

      // 先给会话塞点别的 metadata（模拟挂件会话带 client 信息的情况）
      const session = await Session.findByPk(id);
      if (session === null) throw new Error('会话不存在');
      session.metadata = { client: 'test-agent/1.0' };
      await session.save();

      const r = await http.acmeCustomer.post(
        `/sessions/${id}/tool-approvals`,
        { tool_name: 'submit_refund_request', args: { order_no: 'SO-META', amount: 1 } },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(200);

      // **重新查库**（不是看内存里的对象）—— 这才是「下一轮对话」读到的
      const fresh = await Session.findByPk(id);
      const approvals = fresh?.metadata?.approved_tool_calls ?? [];
      expect(approvals.length, '批准记录应该真的写进库了').toBe(1);
      expect(approvals[0]?.tool_name).toBe('submit_refund_request');
      expect(approvals[0]?.state).toBe('approved');
      // 原来的 metadata 不能被覆盖掉
      expect(fresh?.metadata?.client).toBe('test-agent/1.0');
    });
  });

  describe('POST /sessions/:id/tool-approvals/reject · 取消', () => {
    it('200 + 记录一条拒绝（用户反悔）', async () => {
      const id = await newSession();
      const r = await http.acmeCustomer.post(
        `/sessions/${id}/tool-approvals/reject`,
        { tool_name: 'submit_refund_request', args: { order_no: 'SO-2', amount: 99 } },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(200);
      expect((r.data as { ok: boolean }).ok).toBe(true);
    });

    it('404 别人的会话', async () => {
      const id = await newSession();
      const r = await http.globCustomer.post(
        `/sessions/${id}/tool-approvals/reject`,
        { tool_name: 'submit_refund_request', args: { order_no: 'SO-2' } },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(404);
    });
  });

  describe('挂件（匿名会话）也能确认', () => {
    it('200 + 用匿名 token 认领会话后确认', async () => {
      const created = await axios.post(
        `${BASE}/api/v1/public/widget/acme/sessions`,
        {},
        { validateStatus: () => true },
      );
      expect(created.status).toBe(201);
      const { session_id: sessionId, token } = created.data as {
        session_id: string;
        token: string;
      };

      const r = await axios.post(
        `${BASE}/api/v1/public/widget/acme/tool-approvals`,
        { tool_name: 'submit_refund_request', args: { order_no: 'SO-3' } },
        { headers: { 'x-widget-token': token }, validateStatus: () => true },
      );
      expect(r.status).toBe(200);
      expect((r.data as { ok: boolean }).ok).toBe(true);
      void sessionId;
    });

    it('404 没有 token（认领不到会话）', async () => {
      const r = await axios.post(
        `${BASE}/api/v1/public/widget/acme/tool-approvals`,
        { tool_name: 'submit_refund_request', args: { order_no: 'SO-3' } },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(404);
    });
  });
});
