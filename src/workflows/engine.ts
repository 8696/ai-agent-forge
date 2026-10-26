import { Op } from 'sequelize';
import { Mission, ToolCallLog, type MissionContext, type MissionState } from '../models';
import { logger } from '../logger';
import { getBuiltinTool } from '../tools/builtin/registry';
import { approvalKey } from '../tools/approval-key';
import {
  WORKFLOWS,
  findFlowByTrigger,
  findFlowByType,
  findNodeByTool,
  type GateDecision,
  type WorkflowDefinition,
  type WorkflowNode,
} from './types';

export type { GateDecision } from './types';

/**
 * 工作流引擎 —— B5 状态机工作流
 *
 * 流程规格见 docs/12-b-需求-ai对话能力.md §B5.1（三条电商流程的状态图）。
 *
 * ## 这个引擎管什么
 *
 *  1. **识别**：模型调的某个工具属于哪条流程（`src/workflows/types.ts` 的 `WORKFLOWS`）
 *  2. **拦**：前置节点没做完 → 拦下来，告诉模型「先做什么」
 *  3. **记**：任务状态落 `missions` 表（`pending` / `running` / `awaiting_confirmation` / …）
 *  4. **推进**：节点完成 → 记进度、推状态
 *  5. **恢复**：进程重启后能从 `missions` 读出「这个流程走到哪了」
 *
 * ## ⚠️ 关键语义：模型驱动，不是图驱动
 *
 * **推动流程前进的是模型调工具，不是引擎自己往下走。**
 * 引擎只负责「约束顺序 + 记录进度」。
 *
 * 这跟 LangGraph 相反 —— LangGraph 的图自己会走到下一个节点，
 * 模型只是节点里的一个组件。本引擎没有那个能力：
 * 断点恢复后需要用户再说一句话，模型才会继续调下一个工具。
 *
 * 这个差别是「要不要上 LangGraph」的核心判据（见 12-b §B5.1.4）。
 */

/** 任务在会话里最多存活多久（等确认期间过期 → cancelled） */
export const MISSION_TTL_MS = 30 * 60 * 1000;

/** 未结束的状态 —— 只有这三种算「进行中」 */
const ACTIVE_STATES: readonly MissionState[] = ['pending', 'running', 'awaiting_confirmation'];

// ===== 闸门决策 =====

export interface GateInput {
  tenantId: string;
  sessionId: string | null;
  userId: string | null;
  /** 模型调用的注册名 */
  toolName: string;
  /** 内置实现 key */
  builtin: string;
  args: unknown;
  /** 该工具是否敏感 */
  sensitive: boolean;
  /** 已批准的键（`工具名:入参指纹`） */
  approvals: ReadonlySet<string>;
  /** 用户取消过的键 */
  rejections: ReadonlySet<string>;
  /** 工具名 → 用户已确认的那份入参 */
  approvedArgs: ReadonlyMap<string, unknown>;
}

// ===== context 读写 =====

function readSteps(context: MissionContext | null): string[] {
  return Array.isArray(context?.steps) ? [...(context?.steps as string[])] : [];
}

function readOutputs(context: MissionContext | null): Record<string, unknown> {
  const out = context?.outputs;
  return typeof out === 'object' && out !== null ? { ...(out as Record<string, unknown>) } : {};
}

/** 把 mission 的 context 合并进新值（**必须复制** —— 原地改 Sequelize 不触发 UPDATE） */
function mergeContext(
  context: MissionContext | null,
  patch: { steps?: string[]; outputs?: Record<string, unknown>; approved_args?: unknown },
): MissionContext {
  const base: MissionContext = { ...(context ?? {}) };
  if (patch.steps !== undefined) {
    base.steps = patch.steps;
  }
  if (patch.outputs !== undefined) {
    base.outputs = { ...readOutputs(context), ...patch.outputs };
  }
  if (patch.approved_args !== undefined) {
    base.approved_args = patch.approved_args;
  }
  return base;
}

// ===== mission 读写 =====

/**
 * 找这个会话里**进行中**的任务（最近更新的那条）。
 *
 * ⚠️ 一个会话里**可以同时有多个进行中的任务** —— 用户可能先要退款（还没确认），
 *   又说要改地址。两条流程互不干扰，各自的状态各自推进。
 *   所以定位任务必须**按工具**（`findActiveMissionForTool`），
 *   不能「取最新那条」—— 那会把退款的任务当成改地址的任务。
 */
async function findActiveMissions(
  tenantId: string,
  sessionId: string | null,
): Promise<Mission[]> {
  if (sessionId === null) {
    return [];
  }
  const missions = await Mission.findAll({
    where: {
      tenant_id: tenantId,
      session_id: sessionId,
      state: { [Op.in]: [...ACTIVE_STATES] },
    },
    order: [['updated_at', 'DESC']],
    limit: 20,
  });

  // 懒过期：读的时候顺手把过期的转 cancelled（不需要定时任务）
  const alive: Mission[] = [];
  for (const mission of missions) {
    if (mission.expires_at !== null && mission.expires_at.getTime() <= Date.now()) {
      await Mission.update(
        { state: 'cancelled' },
        { where: { id: mission.id, tenant_id: tenantId } },
      );
      mission.state = 'cancelled';
      continue;
    }
    alive.push(mission);
  }
  return alive;
}

/**
 * 找出「包含这个工具」的那条进行中的任务。
 *
 * @param builtin 内置实现 key
 */
async function findActiveMissionForTool(
  tenantId: string,
  sessionId: string | null,
  builtin: string,
): Promise<Mission | null> {
  const missions = await findActiveMissions(tenantId, sessionId);
  for (const mission of missions) {
    const flow = findFlowByType(mission.type);
    if (flow === undefined) {
      continue;
    }
    if (findNodeByTool(flow, builtin) !== undefined) {
      return mission;
    }
  }
  return null;
}

/** 建一条任务 */
async function createMission(params: {
  tenantId: string;
  sessionId: string | null;
  userId: string | null;
  type: string;
  state: MissionState;
  currentStep: string;
  approvalKey: string | null;
  steps: string[];
  outputs: Record<string, unknown>;
}): Promise<Mission> {
  const context: MissionContext = {
    steps: params.steps,
    outputs: params.outputs,
  };
  return Mission.create({
    tenant_id: params.tenantId,
    session_id: params.sessionId,
    user_id: params.userId,
    type: params.type,
    state: params.state,
    is_sensitive: true,
    current_step: params.currentStep,
    approval_key: params.approvalKey,
    context,
    expires_at: new Date(Date.now() + MISSION_TTL_MS),
  });
}

/** 更新任务状态（**必须带 tenant_id** —— A1 的隔离约束） */
async function patchMission(
  tenantId: string,
  missionId: string,
  patch: {
    state?: MissionState;
    current_step?: string | null;
    approval_key?: string | null;
    context?: MissionContext;
    result?: unknown;
    expires_at?: Date | null;
  },
): Promise<void> {
  await Mission.update(patch, { where: { id: missionId, tenant_id: tenantId } });
}

// ===== 前置条件 =====

/**
 * 这个节点的前置节点里，还有哪些没做完。
 *
 * 「做完」有两种判法：
 *  - **任务里记着**（`context.steps`）—— 任务创建之后的节点
 *  - **本会话调过这个工具**（`tool_call_logs`）—— 任务创建**之前**模型就查过了
 *    （典型场景：用户先问「我的订单到哪了」，聊完才说「那帮我退款」）
 */
async function missingPrerequisites(
  tenantId: string,
  sessionId: string | null,
  flow: WorkflowDefinition,
  node: WorkflowNode,
  doneSteps: ReadonlySet<string>,
): Promise<WorkflowNode[]> {
  const missing: WorkflowNode[] = [];
  for (const reqId of node.requires) {
    if (doneSteps.has(reqId)) {
      continue;
    }
    const reqNode = flow.nodes.find((n) => n.id === reqId);
    if (reqNode === undefined) {
      continue;
    }
    if (await toolCalledInSession(tenantId, sessionId, reqNode.tool)) {
      continue;
    }
    missing.push(reqNode);
  }
  return missing;
}

/** 本会话里成功调过这个内置工具吗 */
async function toolCalledInSession(
  tenantId: string,
  sessionId: string | null,
  builtin: string,
): Promise<boolean> {
  if (sessionId === null) {
    return false;
  }
  const row = await ToolCallLog.findOne({
    where: {
      tenant_id: tenantId,
      session_id: sessionId,
      builtin,
      status: 'ok',
    },
    attributes: ['id'],
  });
  return row !== null;
}

// ===== 闸门 =====

const REJECT_MESSAGE =
  '用户已经拒绝执行这个操作。请如实告诉用户，不会执行，也不要重复询问。';

/**
 * 闸门 —— 模型调工具时先过这一关。
 *
 * 判定顺序（**顺序有意义**）：
 *  1. 用户明确拒绝过 → 直接拒（任何流程都一样，不再问第三次）
 *  2. 这个会话有进行中的任务，且当前工具是该流程的节点 → 按流程节点处理
 *  3. 这个工具是某条流程的**触发器** → 建任务，问用户
 *  4. 都不属于 → 普通敏感工具闸门（老逻辑，不建任务）
 */
export async function evaluateGate(input: GateInput): Promise<GateDecision> {
  const key = approvalKey(input.toolName, input.args);

  // ① 用户拒绝过 —— 优先级最高
  if (input.sensitive && input.rejections.has(key)) {
    await cancelActiveMission(input.tenantId, input.sessionId, key);
    return { kind: 'reject', message: REJECT_MESSAGE };
  }

  const mission = await findActiveMissionForTool(
    input.tenantId,
    input.sessionId,
    input.builtin,
  );
  const flow = mission === null ? undefined : findFlowByType(mission.type);
  const node = flow === undefined ? undefined : findNodeByTool(flow, input.builtin);

  // ② 进行中的流程，当前工具是它的节点
  if (mission !== null && flow !== undefined && node !== undefined) {
    if (!node.confirm) {
      // 只读节点 —— 放行，执行完由 recordStepSuccess 记进度
      return { kind: 'allow', missionId: mission.id, nodeId: node.id };
    }
    return await handleConfirmNode(input, mission, flow, node, key);
  }

  // ③ 触发器 —— 建任务
  const triggerFlow = findFlowByTrigger(input.builtin);
  if (triggerFlow !== undefined) {
    return await handleTrigger(input, triggerFlow, key);
  }

  // ④ 不属于任何流程
  if (!input.sensitive) {
    return { kind: 'allow', missionId: null, nodeId: null };
  }
  if (!input.approvals.has(key)) {
    const approved = input.approvedArgs.get(input.toolName);
    return {
      kind: 'await',
      missionId: null,
      message:
        approved !== undefined
          ? `用户已经确认过这个工具，确认的参数是 ${JSON.stringify(approved)}。` +
            '请用这组参数再调用一次本工具，不要用别的参数。'
          : '该操作需要用户确认后才能执行。请把需要确认的内容（参数摘要）告诉用户，' +
            '等用户明确同意后，再调用一次本工具（参数保持不变）。',
      confirmHint: approved !== undefined
        ? `「${toolDisplayName(input.builtin)}」需要用用户已确认的参数执行（当前参数与确认的不一致）。`
        : `「${toolDisplayName(input.builtin)}」会真实产生一条单据，需要用户确认后才能执行。`,
      ...(approved !== undefined ? { approvedArgs: approved } : {}),
    };
  }
  return { kind: 'allow', missionId: null, nodeId: null };
}

/**
 * 处理「确认节点」—— 前置齐了、用户在等点头。
 */
async function handleConfirmNode(
  input: GateInput,
  mission: Mission,
  flow: WorkflowDefinition,
  node: WorkflowNode,
  key: string,
): Promise<GateDecision> {
  const doneSteps = new Set(readSteps(mission.context));
  const missing = await missingPrerequisites(
    input.tenantId,
    input.sessionId,
    flow,
    node,
    doneSteps,
  );

  if (missing.length > 0) {
    await patchMission(input.tenantId, mission.id, {
      state: 'pending',
      current_step: node.id,
    });
    return {
      kind: 'blocked',
      missionId: mission.id,
      message: buildBlockedMessage(flow, missing),
    };
  }

  // 用户点过了 → 放行
  if (input.approvals.has(key)) {
    await patchMission(input.tenantId, mission.id, {
      state: 'running',
      current_step: node.id,
      approval_key: key,
      expires_at: new Date(Date.now() + MISSION_TTL_MS),
    });
    return { kind: 'allow', missionId: mission.id, nodeId: node.id };
  }

  // 用户还没点头 —— 停在这儿等
  await patchMission(input.tenantId, mission.id, {
    state: 'awaiting_confirmation',
    current_step: node.id,
    approval_key: key,
    expires_at: new Date(Date.now() + MISSION_TTL_MS),
  });

  const approved = input.approvedArgs.get(input.toolName);
  return {
    kind: 'await',
    missionId: mission.id,
    message:
      approved !== undefined
        ? `用户已经确认过这个工具，确认的参数是 ${JSON.stringify(approved)}。` +
          '请用这组参数再调用一次本工具，不要用别的参数。'
        : '该操作需要用户确认后才能执行。请把需要确认的内容（参数摘要）告诉用户，' +
          '等用户明确同意后，再调用一次本工具（参数保持不变）。',
    confirmHint:
      approved !== undefined
        ? `「${toolDisplayName(input.builtin)}」需要用用户已确认的参数执行（当前参数与确认的不一致）。`
        : `「${toolDisplayName(input.builtin)}」会真实产生一条单据，需要用户确认后才能执行。`,
    ...(approved !== undefined ? { approvedArgs: approved } : {}),
  };
}

/**
 * 处理「流程触发器」—— 模型第一次调这个流程的确认工具。
 *
 * 前置没齐也**建任务**（状态 pending），这样任务从一开始就有账可查，
 * 断点恢复时也知道「这个流程卡在缺哪一步」。
 */
async function handleTrigger(
  input: GateInput,
  flow: WorkflowDefinition,
  key: string,
): Promise<GateDecision> {
  const triggerNode = flow.nodes.find((n) => n.tool === flow.trigger);
  if (triggerNode === undefined) {
    // 定义写错了（触发器不在节点表里）—— 当普通敏感工具处理，别卡住对话
    logger.error({ flow: flow.type }, '流程定义有误：触发器不在节点表里');
    return { kind: 'allow', missionId: null, nodeId: null };
  }

  const doneSteps = new Set<string>();
  const missing: WorkflowNode[] = [];
  for (const reqId of triggerNode.requires) {
    const reqNode = flow.nodes.find((n) => n.id === reqId);
    if (reqNode === undefined) {
      continue;
    }
    if (await toolCalledInSession(input.tenantId, input.sessionId, reqNode.tool)) {
      doneSteps.add(reqNode.id);
      continue;
    }
    missing.push(reqNode);
  }

  const mission = await createMission({
    tenantId: input.tenantId,
    sessionId: input.sessionId,
    userId: input.userId,
    type: flow.type,
    state: missing.length > 0 ? 'pending' : 'awaiting_confirmation',
    currentStep: triggerNode.id,
    approvalKey: key,
    steps: [...doneSteps],
    outputs: {},
  });

  if (missing.length > 0) {
    return {
      kind: 'blocked',
      missionId: mission.id,
      message: buildBlockedMessage(flow, missing),
    };
  }

  return {
    kind: 'await',
    missionId: mission.id,
    message:
      '该操作需要用户确认后才能执行。请把需要确认的内容（参数摘要）告诉用户，' +
      '等用户明确同意后，再调用一次本工具（参数保持不变）。',
    confirmHint: `「${toolDisplayName(input.builtin)}」会真实产生一条单据，需要用户确认后才能执行。`,
  };
}

/** 「先做什么」的提示语 */
function buildBlockedMessage(flow: WorkflowDefinition, missing: WorkflowNode[]): string {
  const tools = missing.map((n) => n.tool).join('、');
  const titles = missing.map((n) => n.title).join('；');
  return (
    `「${flow.title}」这个操作还不能执行 —— 缺少前置步骤：${titles}。` +
    `请先调用 ${tools} 拿到这些信息，然后再调用本工具。`
  );
}

/** 工具的显示名（给模型看的那句「XXX需要用户确认」） */
function toolDisplayName(builtin: string): string {
  return getBuiltinTool(builtin)?.name ?? builtin;
}

// ===== 推进 =====

/**
 * 一个节点执行成功之后 —— 记进度、推状态。
 *
 * 状态怎么走：
 *  - 还有下一个节点 → `running`（模型会接着调；下一个是确认节点时，
 *    闸门会把它转成 `awaiting_confirmation`）
 *  - 没有下一个节点了 → `completed`，结果落 `result`
 */
export async function recordStepSuccess(input: {
  tenantId: string;
  missionId: string | null;
  nodeId: string | null;
  builtin: string;
  output: unknown;
}): Promise<void> {
  if (input.missionId === null || input.nodeId === null) {
    return;
  }
  const mission = await Mission.findOne({
    where: { id: input.missionId, tenant_id: input.tenantId },
  });
  if (mission === null) {
    return;
  }
  const flow = findFlowByType(mission.type);
  if (flow === undefined) {
    return;
  }

  const steps = new Set(readSteps(mission.context));
  steps.add(input.nodeId);
  const outputs = { ...readOutputs(mission.context), [input.nodeId]: input.output };

  // 下一个节点：前置全满足、且还没做的
  const next = flow.nodes.find(
    (n) => !steps.has(n.id) && n.requires.every((r) => steps.has(r)),
  );

  if (next === undefined) {
    await patchMission(input.tenantId, mission.id, {
      state: 'completed',
      current_step: null,
      context: mergeContext(mission.context, { steps: [...steps], outputs }),
      result: { steps: [...steps], outputs },
      expires_at: null,
    });
    return;
  }

  await patchMission(input.tenantId, mission.id, {
    state: 'running',
    current_step: next.id,
    context: mergeContext(mission.context, { steps: [...steps], outputs }),
  });
}

// ===== 用户处置 =====

/** 用户点了「确认执行」→ 任务从 awaiting_confirmation 转 running */
export async function onUserApproved(
  tenantId: string,
  sessionId: string | null,
  key: string,
): Promise<void> {
  if (sessionId === null) {
    return;
  }
  await Mission.update(
    {
      state: 'running',
      expires_at: new Date(Date.now() + MISSION_TTL_MS),
    },
    {
      where: {
        tenant_id: tenantId,
        session_id: sessionId,
        approval_key: key,
        state: 'awaiting_confirmation',
      },
    },
  );
}

/** 用户点了「取消」→ 任务转 cancelled */
export async function onUserRejected(
  tenantId: string,
  sessionId: string | null,
  key: string,
): Promise<void> {
  if (sessionId === null) {
    return;
  }
  await Mission.update(
    { state: 'cancelled' },
    {
      where: {
        tenant_id: tenantId,
        session_id: sessionId,
        approval_key: key,
        state: { [Op.in]: ['pending', 'running', 'awaiting_confirmation'] },
      },
    },
  );
}

/** 闸门发现用户拒绝过时，把对应任务也取消掉 */
async function cancelActiveMission(
  tenantId: string,
  sessionId: string | null,
  key: string,
): Promise<void> {
  await onUserRejected(tenantId, sessionId, key);
}

// ===== 断点恢复 =====

/**
 * 给模型的「流程进度」提示段。
 *
 * ⚠️ **这是模型驱动方案的补偿手段**：进程重启后，图不会自己往前走，
 *    得靠这段提示告诉模型「刚才那件事走到哪了，接着做」。
 *
 * 没有进行中的任务 → 返回 null（不注入提示词）。
 */
export async function buildWorkflowHint(
  tenantId: string,
  sessionId: string | null,
): Promise<string | null> {
  const missions = await findActiveMissions(tenantId, sessionId);
  const mission = missions[0];
  if (mission === undefined) {
    return null;
  }
  const flow = findFlowByType(mission.type);
  if (flow === undefined) {
    return null;
  }

  const steps = new Set(readSteps(mission.context));
  const done = flow.nodes.filter((n) => steps.has(n.id)).map((n) => n.title);
  const next = flow.nodes.find(
    (n) => !steps.has(n.id) && n.requires.every((r) => steps.has(r)),
  );

  const lines = [`有一件「${flow.title}」的任务还没完成（状态：${mission.state}）。`];
  if (done.length > 0) {
    lines.push(`已完成：${done.join('；')}。`);
  }
  if (next !== undefined) {
    lines.push(`下一步：${next.title}（用 ${next.tool} 工具）。`);
  }
  if (mission.state === 'awaiting_confirmation') {
    lines.push('⚠️ 这一步正在等用户确认 —— 不要重复发起，先问用户是否已确认。');
  }
  return lines.join('');
}

/** 全部流程定义（后台 / 文档用） */
export function listWorkflows(): readonly WorkflowDefinition[] {
  return WORKFLOWS;
}
