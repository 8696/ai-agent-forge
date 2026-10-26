import { AgentRun, AgentStep, type AgentStepState } from '../models';

/**
 * 多代理批次的数据访问 —— B6 多代理协作
 *
 * 详见 docs/12-b-需求-ai对话能力.md §B6。
 *
 * ## 租户隔离
 *
 * 每一处查询都带 `tenant_id`（A1 的红线，
 * `tests/unit/tenant-isolation-guard.test.ts` 会扫这段代码）。
 */
export interface AgentRunView {
  id: string;
  session_id: string | null;
  turn_id: string | null;
  question: string;
  state: 'running' | 'completed' | 'failed';
  shared_state: Record<string, unknown> | null;
  created_at: string;
}

export function toAgentRunView(row: AgentRun): AgentRunView {
  return {
    id: row.id,
    session_id: row.session_id,
    turn_id: row.turn_id,
    question: row.question,
    state: row.state,
    shared_state: row.shared_state,
    created_at: row.created_at.toISOString(),
  };
}

/**
 * 找到「本轮」的批次，没有就建一个。
 *
 * **一轮对话 = 一个批次**：主 agent 在这一轮里派的每一次活都属于同一个批次，
 * 共享状态互通；下一轮就是新批次。
 *
 * @param turnId 触发这轮对话的 assistant 消息 id（唯一标识「本轮」）
 */
export async function findOrCreateRun(params: {
  tenantId: string;
  sessionId: string | null;
  userId: string | null;
  turnId: string;
  question: string;
}): Promise<AgentRun> {
  const existing = await AgentRun.findOne({
    where: {
      tenant_id: params.tenantId,
      turn_id: params.turnId,
      state: 'running',
    },
    order: [['created_at', 'DESC']],
  });
  if (existing !== null) {
    return existing;
  }

  return AgentRun.create({
    tenant_id: params.tenantId,
    session_id: params.sessionId,
    user_id: params.userId,
    turn_id: params.turnId,
    question: params.question,
    state: 'running',
    shared_state: {},
  });
}

/** 读这个批次的共享状态 */
export async function getSharedState(
  tenantId: string,
  runId: string,
): Promise<Record<string, unknown>> {
  const row = await AgentRun.findOne({
    where: { id: runId, tenant_id: tenantId },
    attributes: ['shared_state'],
  });
  const state = row?.shared_state;
  return typeof state === 'object' && state !== null ? { ...state } : {};
}

/**
 * 记一次子代理调用，并把它��产出并进共享状态。
 *
 * **共享状态是「子代理之间协作」的唯一通道** —— 下一个子代理跑的时候，
 * 引擎把这份状态注入它的提示词（不是主 agent 转述）。
 */
export async function recordStep(params: {
  tenantId: string;
  runId: string;
  agent: string;
  task: string;
  output: unknown;
  state: AgentStepState;
  error?: string | null;
  spanId?: string | null;
}): Promise<AgentStep> {
  const step = await AgentStep.create({
    tenant_id: params.tenantId,
    run_id: params.runId,
    agent: params.agent,
    task: params.task,
    output: params.output,
    state: params.state,
    error: params.error ?? null,
    span_id: params.spanId ?? null,
  });

  // 成功才并进共享状态 —— 失败的产出不该污染别人的输入
  if (params.state === 'ok') {
    const current = await getSharedState(params.tenantId, params.runId);
    await AgentRun.update(
      { shared_state: { ...current, [params.agent]: params.output } },
      { where: { id: params.runId, tenant_id: params.tenantId } },
    );
  }

  return step;
}

/** 批次里的所有步骤（按时间正序） */
export async function listSteps(
  tenantId: string,
  runId: string,
): Promise<AgentStep[]> {
  return AgentStep.findAll({
    where: { tenant_id: tenantId, run_id: runId },
    order: [['created_at', 'ASC']],
  });
}

/** 某个会话跑过的批次（最近的） */
export async function listRuns(
  tenantId: string,
  sessionId: string,
  limit = 20,
): Promise<AgentRun[]> {
  return AgentRun.findAll({
    where: { tenant_id: tenantId, session_id: sessionId },
    order: [['created_at', 'DESC']],
    limit,
  });
}
