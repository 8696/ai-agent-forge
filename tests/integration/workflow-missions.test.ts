/**
 * tests/integration/workflow-missions.test.ts
 * 对应 src/workflows/engine.ts（B5 工作流引擎）+ src/models/Mission.ts
 * 详见 docs/12-b-需求-ai对话能力.md §B5 / §B5.1
 *
 * ## 为什么直接调引擎，不走 HTTP
 *
 * 走 HTTP 会把 LLM 调进来（要真实 provider 凭据、要花钱、还不确定模型会不会按顺序调工具）。
 * 本文件验的是**引擎的状态机**（前置拦不拦、状态怎么转、跨租户隔不隔），
 * 这些跟模型行为无关 —— 直接调 `evaluateGate` / `recordStepSuccess` 更准。
 *
 * 模型那部分由 tests/integration/tool-calling-e2e.test.ts 覆盖。
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { getSequelize } from '../../src/db';
import { Mission, Session, Tenant as TenantModel, ToolCallLog, User } from '../../src/models';
import {
  buildWorkflowHint,
  evaluateGate,
  onUserApproved,
  onUserRejected,
  recordStepSuccess,
} from '../../src/workflows/engine';
import { approvalKey } from '../../src/tools/approval-key';

const EMPTY = {
  approvals: new Set<string>(),
  rejections: new Set<string>(),
  approvedArgs: new Map<string, unknown>(),
};

interface TenantCtx {
  tenantId: string;
  userId: string;
}

let acme: TenantCtx;
let globex: TenantCtx;

/** 按租户号找租户 + 它的 customer 用户 */
async function tenantCtx(code: string): Promise<TenantCtx> {
  const tenant = await TenantModel.findOne({ where: { code } });
  if (tenant === null) {
    throw new Error(`fixture 里没有租户 ${code}（先跑 yarn seed）`);
  }
  const user = await User.findOne({ where: { tenant_id: tenant.id, role: 'customer' } });
  if (user === null) {
    throw new Error(`租户 ${code} 没有 customer 用户`);
  }
  return { tenantId: tenant.id, userId: user.id };
}

beforeAll(async () => {
  // ⚠️ **必须显式触发 init** —— `src/models/index.ts` 只是模型定义，
  //   真正把它们挂到 Sequelize 实例上的是 `src/db.ts` 的 `getSequelize()`。
  //   不调这一句，所有 `Model.findOne` 都会报
  //   「Model not initialized: Tenant needs to be added to a Sequelize instance」。
  getSequelize();
  acme = await tenantCtx('acme');
  globex = await tenantCtx('globex');
});

/** 建一个会话 */
async function newSession(t: TenantCtx): Promise<string> {
  const s = await Session.create({
    tenant_id: t.tenantId,
    user_id: t.userId,
    channel: 'web',
    status: 'active',
    title: null,
    started_at: new Date(),
  });
  return s.id;
}

/** 模拟「模型成功调过这个工具」（写一条 tool_call_logs —— 前置检查就是查它） */
async function pretendCalled(
  tenantId: string,
  sessionId: string,
  builtin: string,
): Promise<void> {
  await ToolCallLog.create({
    tenant_id: tenantId,
    session_id: sessionId,
    user_id: null,
    message_id: null,
    tool_call_id: `call-${Math.random().toString(36).slice(2, 10)}`,
    tool_name: builtin,
    builtin,
    status: 'ok',
    args: {},
    output: {},
    error: null,
    duration_ms: 1,
    trace_id: null,
  });
}

/** 这个会话里的任务 */
async function missionOf(tenantId: string, sessionId: string): Promise<Mission | null> {
  return Mission.findOne({
    where: { tenant_id: tenantId, session_id: sessionId },
    order: [['created_at', 'DESC']],
  });
}

afterEach(async () => {
  // 清掉这两个租户名下测试产生的任务，避免用例之间串状态
  // ⚠️ **不能用 truncate** —— MySQL 的 TRUNCATE 不带 WHERE，会把整张表清空
  await Mission.destroy({ where: { tenant_id: acme.tenantId } });
  await Mission.destroy({ where: { tenant_id: globex.tenantId } });
  await ToolCallLog.destroy({
    where: { tenant_id: acme.tenantId, builtin: 'submit_refund_request' },
  });
  await ToolCallLog.destroy({
    where: { tenant_id: acme.tenantId, builtin: 'query_order_status' },
  });
  await ToolCallLog.destroy({
    where: { tenant_id: acme.tenantId, builtin: 'query_coupon_info' },
  });
});

describe('B5 工作流引擎 · 退款流程', () => {
  it('前置没做就调提交 → 拦下（blocked），并落一行 pending 任务', async () => {
    const sid = await newSession(acme);

    const decision = await evaluateGate({
      tenantId: acme.tenantId,
      sessionId: sid,
      userId: acme.userId,
      toolName: 'submit_refund_request',
      builtin: 'submit_refund_request',
      args: { order_no: 'SO-1', reason: '不想要了' },
      sensitive: true,
      ...EMPTY,
    });

    expect(decision.kind).toBe('blocked');
    if (decision.kind === 'blocked') {
      expect(decision.message).toContain('query_order_status');
      expect(decision.message).toContain('query_coupon_info');
    }

    const m = await missionOf(acme.tenantId, sid);
    expect(m).not.toBeNull();
    expect(m?.type).toBe('refund_request');
    expect(m?.state).toBe('pending');
  });

  it('前置齐了 → 拦下等确认（awaiting_confirmation）', async () => {
    const sid = await newSession(acme);
    await pretendCalled(acme.tenantId, sid, 'query_order_status');
    await pretendCalled(acme.tenantId, sid, 'query_coupon_info');

    const decision = await evaluateGate({
      tenantId: acme.tenantId,
      sessionId: sid,
      userId: acme.userId,
      toolName: 'submit_refund_request',
      builtin: 'submit_refund_request',
      args: { order_no: 'SO-1', reason: '不想要了' },
      sensitive: true,
      ...EMPTY,
    });

    expect(decision.kind).toBe('await');
    const m = await missionOf(acme.tenantId, sid);
    expect(m?.state).toBe('awaiting_confirmation');
    expect(m?.is_sensitive).toBe(true);
  });

  it('用户确认 → running → 工具执行完 → completed', async () => {
    const sid = await newSession(acme);
    await pretendCalled(acme.tenantId, sid, 'query_order_status');
    await pretendCalled(acme.tenantId, sid, 'query_coupon_info');

    const args = { order_no: 'SO-1', reason: '不想要了' };
    const key = approvalKey('submit_refund_request', args);

    const first = await evaluateGate({
      tenantId: acme.tenantId,
      sessionId: sid,
      userId: acme.userId,
      toolName: 'submit_refund_request',
      builtin: 'submit_refund_request',
      args,
      sensitive: true,
      ...EMPTY,
    });
    expect(first.kind).toBe('await');

    // 用户点了「确认执行」
    await onUserApproved(acme.tenantId, sid, key);
    expect((await missionOf(acme.tenantId, sid))?.state).toBe('running');

    // 下一轮模型用同样的参数再调一次 → 放行
    const second = await evaluateGate({
      tenantId: acme.tenantId,
      sessionId: sid,
      userId: acme.userId,
      toolName: 'submit_refund_request',
      builtin: 'submit_refund_request',
      args,
      sensitive: true,
      approvals: new Set([key]),
      rejections: new Set<string>(),
      approvedArgs: new Map<string, unknown>(),
    });
    expect(second.kind).toBe('allow');

    // 工具执行成功 → 记进度 → 流程走完 → completed
    await recordStepSuccess({
      tenantId: acme.tenantId,
      missionId: second.kind === 'allow' ? second.missionId : null,
      nodeId: second.kind === 'allow' ? second.nodeId : null,
      builtin: 'submit_refund_request',
      output: { refund_no: 'RF-1' },
    });

    const m = await missionOf(acme.tenantId, sid);
    expect(m?.state).toBe('completed');
    expect(m?.result).toBeDefined();
  });

  it('用户拒绝 → cancelled（不执行副作用）', async () => {
    const sid = await newSession(acme);
    await pretendCalled(acme.tenantId, sid, 'query_order_status');
    await pretendCalled(acme.tenantId, sid, 'query_coupon_info');

    const args = { order_no: 'SO-1', reason: '不想要了' };
    const key = approvalKey('submit_refund_request', args);

    await evaluateGate({
      tenantId: acme.tenantId,
      sessionId: sid,
      userId: acme.userId,
      toolName: 'submit_refund_request',
      builtin: 'submit_refund_request',
      args,
      sensitive: true,
      ...EMPTY,
    });

    await onUserRejected(acme.tenantId, sid, key);
    expect((await missionOf(acme.tenantId, sid))?.state).toBe('cancelled');
  });

  it('用户拒绝过 → 闸门直接回「用户拒绝」，不再问第三次', async () => {
    const sid = await newSession(acme);
    await pretendCalled(acme.tenantId, sid, 'query_order_status');
    await pretendCalled(acme.tenantId, sid, 'query_coupon_info');

    const args = { order_no: 'SO-1', reason: '不想要了' };
    const key = approvalKey('submit_refund_request', args);

    await evaluateGate({
      tenantId: acme.tenantId,
      sessionId: sid,
      userId: acme.userId,
      toolName: 'submit_refund_request',
      builtin: 'submit_refund_request',
      args,
      sensitive: true,
      ...EMPTY,
    });
    await onUserRejected(acme.tenantId, sid, key);

    const after = await evaluateGate({
      tenantId: acme.tenantId,
      sessionId: sid,
      userId: acme.userId,
      toolName: 'submit_refund_request',
      builtin: 'submit_refund_request',
      args,
      sensitive: true,
      approvals: new Set<string>(),
      rejections: new Set([key]),
      approvedArgs: new Map<string, unknown>(),
    });

    expect(after.kind).toBe('reject');
  });
});

describe('B5 工作流引擎 · 租户隔离', () => {
  it('另一个租户看不到本租户的任务（前置查不到 → 照样拦）', async () => {
    const sid = await newSession(acme);
    await pretendCalled(acme.tenantId, sid, 'query_order_status');
    await pretendCalled(acme.tenantId, sid, 'query_coupon_info');

    await evaluateGate({
      tenantId: acme.tenantId,
      sessionId: sid,
      userId: acme.userId,
      toolName: 'submit_refund_request',
      builtin: 'submit_refund_request',
      args: { order_no: 'SO-1' },
      sensitive: true,
      ...EMPTY,
    });

    // 用 globex 的身份查同一个 session → 查不到任务
    const globSession = await newSession(globex);
    const decision = await evaluateGate({
      tenantId: globex.tenantId,
      sessionId: globSession,
      userId: globex.userId,
      toolName: 'submit_refund_request',
      builtin: 'submit_refund_request',
      args: { order_no: 'SO-1' },
      sensitive: true,
      ...EMPTY,
    });

    // globex 自己没有查过订单 → 它的任务也是 pending（不是「借了」acme 的进度）
    const m = await missionOf(globex.tenantId, globSession);
    expect(m?.tenant_id).toBe(globex.tenantId);
    expect(m?.state).toBe('pending');
    expect(decision.kind).toBe('blocked');
  });

  it('acme 的任务查不到 globex 的会话', async () => {
    const sid = await newSession(acme);
    const rows = await Mission.findAll({ where: { session_id: sid } });
    expect(rows.every((r) => r.tenant_id === acme.tenantId)).toBe(true);
  });
});

describe('B5 工作流引擎 · 断点恢复', () => {
  it('有进行中的任务 → 给出「接着做」的提示段', async () => {
    const sid = await newSession(acme);
    await pretendCalled(acme.tenantId, sid, 'query_order_status');

    const decision = await evaluateGate({
      tenantId: acme.tenantId,
      sessionId: sid,
      userId: acme.userId,
      toolName: 'submit_refund_request',
      builtin: 'submit_refund_request',
      args: { order_no: 'SO-1' },
      sensitive: true,
      ...EMPTY,
    });
    expect(decision.kind).toBe('blocked');

    const hint = await buildWorkflowHint(acme.tenantId, sid);
    expect(hint).not.toBeNull();
    expect(hint).toContain('退款申请');
  });

  it('没有进行中的任务 → 不给提示段', async () => {
    const sid = await newSession(acme);
    const hint = await buildWorkflowHint(acme.tenantId, sid);
    expect(hint).toBeNull();
  });
});
