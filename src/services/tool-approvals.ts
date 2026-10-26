import { Session, type SessionMetadata, type SessionToolApproval } from '../models';
import { NotFoundError } from '../lib/errors';
import { approvalKey } from '../tools/approval-key';
import { onUserApproved, onUserRejected } from '../workflows/engine';

/**
 * 敏感工具的人工确认（B3 HITL）
 *
 * ## 完整流程
 *
 * ```
 * 模型调用 submit_refund_request
 *   ↓ 闸门（src/tools/execute.ts）：敏感 && 这条没批准过
 *   ↓ **不执行**，返回 { status: 'awaiting_confirmation' }
 * 模型在回答里问用户「确认吗」
 *   ↓
 * 用户点「确认执行」→ POST /api/v1/customer/sessions/:id/tool-approvals
 *   ↓ 记一条 state='approved' 的批准
 * 下一轮：系统提示词里带一段「待执行的确认」
 *   ↓ 「用户已确认执行 submit_refund_request（参数 …），请立刻用同样的参数再调一次」
 * 模型再调一次 → 闸门命中批准 → **真正执行**（state 置 'executed'）
 * ```
 *
 * ## 用户可以反悔
 *
 * 点了「确认执行」之后还能点「取消」：
 * `POST .../tool-approvals/reject` 记一条 state='rejected'，
 * 闸门见到就返回「用户拒绝执行这个操作」，模型会如实告诉用户，**不会再问第三次**。
 *
 * ## 批准会过期
 *
 * 批准只在 **30 分钟**内有效（`TOOL_APPROVAL_TTL_MS`）——
 * 不设过期的话，用户三天前点过一次「确认」，今天的对话里模型还会被提醒
 * 「请立刻再调一次那个工具」，莫名其妙就执行了。
 *
 * ## 批准绑定「工具名 + 那次调用的入参」
 *
 * 只按工具名批准的话，用户点了「确认提交 200 元」，
 * 紧接着模型改成提交 5000 元也会被放行。
 *
 * 但模型**改参数**也不该让用户重新点一次确认 —— 所以闸门拦下它的时候，
 * 会把「用户已确认的那组参数」回传给模型，让它用那组参数再调一次，
 * 指纹就对了。这样既安全，又不用用户来回点。
 */
export type ToolApproval = SessionToolApproval;

/** 批准的有效期（毫秒）—— 过期后当没批准过 */
export const TOOL_APPROVAL_TTL_MS = 30 * 60 * 1000;

/** 读会话的批准记录（过期的按没有处理） */
export async function loadToolApprovals(
  sessionId: string,
  tenantId: string,
): Promise<{
  /** 已批准且没过期、还没执行过的键 → 闸门放行 */
  keys: Set<string>;
  /** 用户明确拒绝过的键 → 闸门返回「用户拒绝」 */
  rejections: Set<string>;
  /** 已批准但还没执行（要提醒模型「请再调一次」） */
  pending: ToolApproval[];
  /** 用户拒绝过的（要提醒模型「不要再调」） */
  rejected: ToolApproval[];
  /** 工具名 → 用户已确认的那份入参（模型改参数时把它回传给它） */
  approvedArgs: Map<string, unknown>;
}> {
  const session = await Session.findOne({
    where: { id: sessionId, tenant_id: tenantId },
    attributes: ['metadata'],
  });
  if (session === null) {
    throw new NotFoundError('会话');
  }

  const list = session.metadata?.approved_tool_calls;
  const records = Array.isArray(list)
    ? (list.filter((x): x is ToolApproval => typeof x === 'object' && x !== null) as ToolApproval[])
    : [];

  const now = Date.now();
  const alive = records.filter(
    (r) => now - new Date(r.approved_at).getTime() <= TOOL_APPROVAL_TTL_MS,
  );

  const keys = new Set<string>();
  const rejections = new Set<string>();
  const pending: ToolApproval[] = [];
  const rejected: ToolApproval[] = [];
  const approvedArgs = new Map<string, unknown>();

  for (const r of alive) {
    if (r.state === 'rejected') {
      rejections.add(r.key);
      rejected.push(r);
      continue;
    }
    if (r.state === 'approved') {
      keys.add(r.key);
      pending.push(r);
      approvedArgs.set(r.tool_name, r.args);
    }
  }

  return { keys, rejections, pending, rejected, approvedArgs };
}

/**
 * 记录一次批准。
 *
 * 同一条批准重复点不报错（幂等）—— 用户可能连点两下按钮。
 */
export async function grantToolApproval(
  sessionId: string,
  tenantId: string,
  toolName: string,
  args: unknown,
): Promise<{ key: string }> {
  const { key } = await upsertApproval(sessionId, tenantId, toolName, args, 'approved');
  // B5 工作流：任务从 awaiting_confirmation 转 running
  //（不属于任何流程的工具没有对应任务，这一步是空操作）
  await onUserApproved(tenantId, sessionId, key);
  return { key };
}

/** 记录一次拒绝（用户点了「取消」） */
export async function rejectToolApproval(
  sessionId: string,
  tenantId: string,
  toolName: string,
  args: unknown,
): Promise<{ key: string }> {
  const { key } = await upsertApproval(sessionId, tenantId, toolName, args, 'rejected');
  // B5 工作流：任务转 cancelled（**不执行副作用**）
  await onUserRejected(tenantId, sessionId, key);
  return { key };
}

async function upsertApproval(
  sessionId: string,
  tenantId: string,
  toolName: string,
  args: unknown,
  state: 'approved' | 'rejected',
): Promise<{ key: string }> {
  const session = await Session.findOne({
    where: { id: sessionId, tenant_id: tenantId },
  });
  if (session === null) {
    throw new NotFoundError('会话');
  }

  const key = approvalKey(toolName, args);
  // ⚠️ **必须复制一份再改** —— 直接改 `session.metadata` 是**原地改同一个对象引用**，
  //    Sequelize 的 `set()` 看到「新值 === 旧值」就认为没变，save() 时这一列压根不进
  //    UPDATE —— 批准记录会**静默丢掉**（闸门永远看不到批准，工具一直卡在「待确认」）。
  const metadata: SessionMetadata = { ...(session.metadata ?? {}) };
  const current = Array.isArray(metadata.approved_tool_calls)
    ? (metadata.approved_tool_calls as ToolApproval[])
    : [];
  const existing = current.find((r) => r.key === key);
  if (existing === undefined) {
    current.push({
      key,
      tool_name: toolName,
      args,
      approved_at: new Date().toISOString(),
      state,
    });
  } else {
    // 重复操作 → 覆盖状态（用户先点了确认又点了取消，或反过来）
    existing.state = state;
    existing.approved_at = new Date().toISOString();
  }
  metadata.approved_tool_calls = current;
  session.metadata = metadata;
  await session.save();

  return { key };
}

/**
 * 标记某条批准的工具**已经真的执行了**（闸门放行之后调用）。
 *
 * 执行之后就不再提醒模型「请再调一次」了。
 */
export async function markToolExecuted(
  sessionId: string,
  tenantId: string,
  key: string,
): Promise<void> {
  const session = await Session.findOne({
    where: { id: sessionId, tenant_id: tenantId },
  });
  if (session === null) {
    return;
  }
  // 同上：复制一份再改（原地改不会触发 UPDATE）
  const metadata: SessionMetadata = { ...(session.metadata ?? {}) };
  const current = Array.isArray(metadata.approved_tool_calls)
    ? (metadata.approved_tool_calls as ToolApproval[])
    : [];
  const hit = current.find((r) => r.key === key);
  if (hit === undefined || hit.state === 'executed') {
    return;
  }
  hit.state = 'executed';
  metadata.approved_tool_calls = current;
  session.metadata = metadata;
  await session.save();
}
