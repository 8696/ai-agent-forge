/**
 * tests/integration/agent-runs.test.ts
 * 对应 src/services/agent-runs.ts（B6 多代理的批次 + 共享状态）
 *          + src/services/trace.ts 的 span 父子关系（调用树）
 * 详见 docs/12-b-需求-ai对话能力.md §B6
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { getSequelize } from '../../src/db';
import { AgentRun, AgentStep, Span, Tenant } from '../../src/models';
import {
  findOrCreateRun,
  getSharedState,
  listRuns,
  listSteps,
  recordStep,
} from '../../src/services/agent-runs';
import { startTrace } from '../../src/services/trace';

let tenantId = '';

beforeAll(async () => {
  getSequelize();
  const tenant = await Tenant.findOne({ where: { code: 'acme' } });
  if (tenant === null) {
    throw new Error('没有 acme 租户（先跑 yarn seed）');
  }
  tenantId = tenant.id;
});

afterEach(async () => {
  await AgentStep.destroy({ where: { tenant_id: tenantId } });
  await AgentRun.destroy({ where: { tenant_id: tenantId } });
});

describe('B6 · 多代理批次', () => {
  it('同一个 turn → 同一个批次', async () => {
    const a = await findOrCreateRun({
      tenantId,
      sessionId: null,
      userId: null,
      turnId: 'turn-1',
      question: '这单到哪了？',
    });
    const b = await findOrCreateRun({
      tenantId,
      sessionId: null,
      userId: null,
      turnId: 'turn-1',
      question: '这单到哪了？',
    });
    expect(b.id).toBe(a.id);
  });

  it('不同 turn → 不同批次', async () => {
    const a = await findOrCreateRun({
      tenantId,
      sessionId: null,
      userId: null,
      turnId: 'turn-1',
      question: 'q1',
    });
    const b = await findOrCreateRun({
      tenantId,
      sessionId: null,
      userId: null,
      turnId: 'turn-2',
      question: 'q2',
    });
    expect(b.id).not.toBe(a.id);
  });

  it('子代理的产出并进共享状态（子代理之间协作的通道）', async () => {
    const run = await findOrCreateRun({
      tenantId,
      sessionId: null,
      userId: null,
      turnId: 'turn-shared',
      question: 'q',
    });

    await recordStep({
      tenantId,
      runId: run.id,
      agent: 'order_agent',
      task: '查订单',
      output: '订单 SO-1，待发货',
      state: 'ok',
    });

    const state = await getSharedState(tenantId, run.id);
    expect(state.order_agent).toBe('订单 SO-1，待发货');
  });

  it('失败的步骤不污染共享状态', async () => {
    const run = await findOrCreateRun({
      tenantId,
      sessionId: null,
      userId: null,
      turnId: 'turn-fail',
      question: 'q',
    });

    await recordStep({
      tenantId,
      runId: run.id,
      agent: 'policy_agent',
      task: '查政策',
      output: '',
      state: 'failed',
      error: '炸了',
    });

    const state = await getSharedState(tenantId, run.id);
    expect(state.policy_agent).toBeUndefined();
  });

  it('步骤都记下来了（按时间正序）', async () => {
    const run = await findOrCreateRun({
      tenantId,
      sessionId: 'sess-1',
      userId: null,
      turnId: 'turn-steps',
      question: 'q',
    });
    await recordStep({
      tenantId,
      runId: run.id,
      agent: 'order_agent',
      task: '第一步',
      output: 'A',
      state: 'ok',
    });
    await recordStep({
      tenantId,
      runId: run.id,
      agent: 'discount_agent',
      task: '第二步',
      output: 'B',
      state: 'ok',
    });

    const steps = await listSteps(tenantId, run.id);
    expect(steps).toHaveLength(2);
    expect(steps[0]?.agent).toBe('order_agent');
    expect(steps[1]?.agent).toBe('discount_agent');
  });

  it('按会话查批次', async () => {
    await findOrCreateRun({
      tenantId,
      sessionId: 'sess-list',
      userId: null,
      turnId: 'turn-list',
      question: 'q',
    });
    const runs = await listRuns(tenantId, 'sess-list');
    expect(runs.length).toBeGreaterThan(0);
  });
});

describe('B6 · trace 调用树', () => {
  it('子 span 的 parent_span_id 落库了', async () => {
    const trace = startTrace({ tenantId, name: 'tree-test' });
    const parent = trace.span('llm.generate', 'llm');
    const child = trace.span('agent.delegate', 'agent', { agent: 'order_agent' }, parent.id);
    await trace.end();

    const parentRow = await Span.findOne({ where: { id: parent.id } });
    const childRow = await Span.findOne({ where: { id: child.id } });
    expect(parentRow).not.toBeNull();
    expect(parentRow?.parent_span_id).toBeNull();
    expect(childRow?.parent_span_id).toBe(parent.id);
  });

  it('多层嵌套的 parent 链对得上', async () => {
    const trace = startTrace({ tenantId, name: 'tree-test-2' });
    const a = trace.span('llm.generate', 'llm');
    const b = trace.span('agent.delegate', 'agent', {}, a.id);
    const c = trace.span('agent.delegate', 'agent', {}, b.id);
    await trace.end();

    const rows = await Span.findAll({ where: { trace_id: trace.id } });
    expect(rows).toHaveLength(3);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(a.id)?.parent_span_id).toBeNull();
    expect(byId.get(b.id)?.parent_span_id).toBe(a.id);
    expect(byId.get(c.id)?.parent_span_id).toBe(b.id);
  });
});
