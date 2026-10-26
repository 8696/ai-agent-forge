/**
 * tests/unit/tool-execute.test.ts
 * 对应 src/tools/execute.ts（工具执行包装层：超时 / 降级 / span / 落库 part / HITL 闸门）
 * 详见 docs/12-b-需求-ai对话能力.md §B3
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import {
  approvalKey,
  buildToolSet,
  hashArgs,
  stableStringify,
  type ToolCallRecord,
  type ToolRuntime,
} from '../../src/tools/execute';
import type { BuiltinTool } from '../../src/tools/builtin/registry';
import type { ResolvedTool } from '../../src/tools/resolve';
import type { GateDecision } from '../../src/workflows/types';

/** 造一个假工具（execute 可替换） */
function fakeTool(over: Partial<BuiltinTool> = {}): BuiltinTool {
  return {
    key: 'fake_tool',
    name: '假工具',
    description: '测试用',
    inputSchema: z.object({ value: z.string().optional() }),
    sampleArgs: {},
    sensitive: false,
    execute: async () => ({ ok: true }),
    ...over,
  };
}

function resolved(impl: BuiltinTool, requiresConfirmation = false): ResolvedTool {
  return {
    name: 'fake_tool',
    description: impl.description,
    impl,
    requiresConfirmation,
  };
}

interface Harness {
  records: ToolCallRecord[];
  spans: Array<{ name: string; ended: boolean; failed: boolean }>;
  runtime: ToolRuntime;
}

function harness(over: Partial<ToolRuntime> = {}): Harness {
  const records: ToolCallRecord[] = [];
  const spans: Array<{ name: string; ended: boolean; failed: boolean }> = [];
  const runtime: ToolRuntime = {
    tenantId: 'tenant-a',
    sessionId: null,
    userId: null,
    approvals: new Set<string>(),
    span: (name) => {
      const entry = { name, ended: false, failed: false };
      spans.push(entry);
      return {
        id: `span-${spans.length}`,
        name,
        kind: 'step',
        end: () => {
          entry.ended = true;
        },
        fail: () => {
          entry.failed = true;
        },
      };
    },
    onCall: (record) => {
      records.push(record);
    },
    ...over,
  };
  return { records, spans, runtime };
}

/** 调一个工具（AI SDK 的 tool().execute(input, { toolCallId })） */
async function callTool(
  set: ReturnType<typeof buildToolSet>,
  name: string,
  input: unknown,
  toolCallId = 'call-1',
): Promise<unknown> {
  const t = set[name];
  if (t === undefined) {
    throw new Error(`工具 ${name} 不在集合里`);
  }
  const fn = t.execute as unknown as (
    i: unknown,
    o: unknown,
  ) => Promise<unknown> | unknown;
  return await fn(input, { toolCallId, messages: [], context: undefined });
}

describe('工具执行包装层', () => {
  it('成功 → status=ok + 记一条 span', async () => {
    const h = harness();
    const set = buildToolSet([resolved(fakeTool())], h.runtime);

    const out = await callTool(set, 'fake_tool', { value: 'x' });

    expect(out).toEqual({ ok: true });
    expect(h.records).toHaveLength(1);
    expect(h.records[0]?.status).toBe('ok');
    expect(h.records[0]?.tool_name).toBe('fake_tool');
    expect(h.spans).toHaveLength(1);
    expect(h.spans[0]?.name).toBe('tool.invoke');
    expect(h.spans[0]?.ended).toBe(true);
  });

  it('工具抛错 → 不抛出去，降级成 tool result 回灌', async () => {
    const h = harness();
    const boom = fakeTool({
      execute: async () => {
        throw new Error('后端炸了');
      },
    });
    const set = buildToolSet([resolved(boom)], h.runtime);

    const out = await callTool(set, 'fake_tool', {});

    expect(String(out)).toContain('工具调用失败');
    expect(String(out)).toContain('后端炸了');
    expect(h.records[0]?.status).toBe('error');
    expect(h.records[0]?.error).toContain('后端炸了');
    expect(h.spans[0]?.failed).toBe(true);
  });

  it('超时 → status=timeout（不重试，直接放弃）', async () => {
    const h = harness({ timeoutMs: 30 });
    const slow = fakeTool({
      execute: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return { ok: true };
      },
    });
    const set = buildToolSet([resolved(slow)], h.runtime);

    const out = await callTool(set, 'fake_tool', {});

    expect(String(out)).toContain('超时');
    expect(h.records[0]?.status).toBe('timeout');
  });

  describe('HITL 闸门（敏感工具）', () => {
    it('没批准 → 不执行，返回 awaiting_confirmation', async () => {
      const exec = vi.fn(async () => ({ ok: true }));
      const h = harness();
      const set = buildToolSet([resolved(fakeTool({ execute: exec }), true)], h.runtime);

      const out = await callTool(set, 'fake_tool', { value: 'x' });

      expect(exec).not.toHaveBeenCalled();
      expect((out as { status: string }).status).toBe('awaiting_confirmation');
      expect(h.records[0]?.status).toBe('awaiting_confirmation');
    });

    it('批准了（同样的参数）→ 真正执行', async () => {
      const exec = vi.fn(async () => ({ ok: true }));
      const h = harness({ approvals: new Set([approvalKey('fake_tool', { value: 'x' })]) });
      const set = buildToolSet([resolved(fakeTool({ execute: exec }), true)], h.runtime);

      const out = await callTool(set, 'fake_tool', { value: 'x' });

      expect(exec).toHaveBeenCalledTimes(1);
      expect(out).toEqual({ ok: true });
      expect(h.records[0]?.status).toBe('ok');
    });

    it('批准了但参数变了 → 仍然拦下（批准绑定到具体那次调用）', async () => {
      const exec = vi.fn(async () => ({ ok: true }));
      const h = harness({
        approvals: new Set([approvalKey('fake_tool', { value: 'x' })]),
        approvedArgs: new Map([['fake_tool', { value: 'x' }]]),
      });
      const set = buildToolSet([resolved(fakeTool({ execute: exec }), true)], h.runtime);

      const out = await callTool(set, 'fake_tool', { value: 'y' });

      expect(exec).not.toHaveBeenCalled();
      expect((out as { status: string }).status).toBe('awaiting_confirmation');
    });

    it('参数变了 → 把「用户已确认的那组参数」回传给模型（不用用户再点一次）', async () => {
      const exec = vi.fn(async () => ({ ok: true }));
      const h = harness({
        approvals: new Set([approvalKey('fake_tool', { value: 'x' })]),
        approvedArgs: new Map([['fake_tool', { value: 'x' }]]),
      });
      const set = buildToolSet([resolved(fakeTool({ execute: exec }), true)], h.runtime);

      const out = await callTool(set, 'fake_tool', { value: 'y' });

      const result = out as { status: string; message: string; approved_args: unknown };
      expect(result.status).toBe('awaiting_confirmation');
      expect(result.approved_args).toEqual({ value: 'x' });
      expect(result.message).toContain('已经确认过');
      expect(result.message).toContain('"value":"x"');
    });

    it('用户拒绝过 → 直接回「用户拒绝」，不再问第三次', async () => {
      const exec = vi.fn(async () => ({ ok: true }));
      const key = approvalKey('fake_tool', { value: 'x' });
      const h = harness({ rejections: new Set([key]) });
      const set = buildToolSet([resolved(fakeTool({ execute: exec }), true)], h.runtime);

      const out = await callTool(set, 'fake_tool', { value: 'x' });

      expect(exec).not.toHaveBeenCalled();
      expect((out as { status: string }).status).toBe('rejected');
      expect(h.records[0]?.status).toBe('rejected');
    });
  });

  describe('入参指纹', () => {
    it('键顺序不同 → 同一个指纹', () => {
      expect(hashArgs({ a: 1, b: 2 })).toBe(hashArgs({ b: 2, a: 1 }));
    });

    it('值不同 → 不同指纹', () => {
      expect(hashArgs({ a: 1 })).not.toBe(hashArgs({ a: 2 }));
    });

    it('stableStringify 丢掉 undefined 的键', () => {
      expect(stableStringify({ a: 1, b: undefined })).toBe('{"a":1}');
    });

    it('approvalKey = 工具名 + 指纹', () => {
      expect(approvalKey('t', { a: 1 })).toBe(`t:${hashArgs({ a: 1 })}`);
    });
  });

  // ============================================================
  // B5 工作流闸门（docs/12-b §B5.1）
  // ============================================================
  describe('工作流闸门', () => {
    /** 造一个只回固定决策的假闸门 */
    function gateHarness(
      decision: GateDecision,
      over: Partial<ToolRuntime> = {},
    ): Harness & { gateCalls: Array<{ toolName: string; builtin: string; sensitive: boolean }> } {
      const gateCalls: Array<{ toolName: string; builtin: string; sensitive: boolean }> = [];
      const h = harness({
        gate: async (input) => {
          gateCalls.push({
            toolName: input.toolName,
            builtin: input.builtin,
            sensitive: input.sensitive,
          });
          return decision;
        },
        ...over,
      });
      return { ...h, gateCalls };
    }

    it('allow → 正常执行，并回调记流程进度（带 missionId / nodeId）', async () => {
      const exec = vi.fn(async () => ({ ok: true }));
      const onToolSucceeded = vi.fn();
      const h = gateHarness(
        { kind: 'allow', missionId: 'm-1', nodeId: 'lookup_order' },
        { onToolSucceeded },
      );
      const set = buildToolSet([resolved(fakeTool({ execute: exec }))], h.runtime);

      const out = await callTool(set, 'fake_tool', { value: 'x' });

      expect(out).toEqual({ ok: true });
      expect(exec).toHaveBeenCalledTimes(1);
      expect(onToolSucceeded).toHaveBeenCalledTimes(1);
      expect(onToolSucceeded.mock.calls[0]?.[0]).toMatchObject({
        toolName: 'fake_tool',
        missionId: 'm-1',
        nodeId: 'lookup_order',
      });
      expect(h.records[0]?.status).toBe('ok');
    });

    it('await → 不执行，回灌 awaiting_confirmation', async () => {
      const exec = vi.fn(async () => ({ ok: true }));
      const h = gateHarness({
        kind: 'await',
        missionId: 'm-1',
        message: '该操作需要用户确认后才能执行。',
        confirmHint: '「提交退款申请」需要用户确认。',
      });
      const set = buildToolSet([resolved(fakeTool({ execute: exec }), true)], h.runtime);

      const out = await callTool(set, 'fake_tool', { value: 'x' });

      expect(exec).not.toHaveBeenCalled();
      const result = out as { status: string; message: string; confirm_hint: string };
      expect(result.status).toBe('awaiting_confirmation');
      expect(result.confirm_hint).toContain('提交退款申请');
      expect(h.records[0]?.status).toBe('awaiting_confirmation');
      // span 也要有（闸门路径同样要覆盖）
      expect(h.spans[0]?.ended).toBe(true);
    });

    it('await + 模型改了参数 → 把用户已确认的那组参数回传给它', async () => {
      const exec = vi.fn(async () => ({ ok: true }));
      const h = gateHarness({
        kind: 'await',
        missionId: 'm-1',
        message: '用户已经确认过这个工具，确认的参数是 {"value":"x"}。',
        confirmHint: '「提交退款申请」需要用用户已确认的参数执行。',
        approvedArgs: { value: 'x' },
      });
      const set = buildToolSet([resolved(fakeTool({ execute: exec }), true)], h.runtime);

      const out = await callTool(set, 'fake_tool', { value: 'y' });

      const result = out as { status: string; approved_args: unknown };
      expect(result.status).toBe('awaiting_confirmation');
      expect(result.approved_args).toEqual({ value: 'x' });
    });

    it('reject → 不执行，回灌「用户拒绝」', async () => {
      const exec = vi.fn(async () => ({ ok: true }));
      const h = gateHarness({
        kind: 'reject',
        message: '用户已经拒绝执行这个操作。',
      });
      const set = buildToolSet([resolved(fakeTool({ execute: exec }), true)], h.runtime);

      const out = await callTool(set, 'fake_tool', { value: 'x' });

      expect(exec).not.toHaveBeenCalled();
      expect((out as { status: string }).status).toBe('rejected');
      expect(h.records[0]?.status).toBe('rejected');
    });

    it('blocked → 不执行，回灌「先做什么」（不是失败，是流程约束）', async () => {
      const exec = vi.fn(async () => ({ ok: true }));
      const h = gateHarness({
        kind: 'blocked',
        missionId: 'm-1',
        message: '「退款申请」这个操作还不能执行 —— 缺少前置步骤：查订单状态。请先调用 query_order_status。',
      });
      const set = buildToolSet([resolved(fakeTool({ execute: exec }), true)], h.runtime);

      const out = await callTool(set, 'fake_tool', { value: 'x' });

      expect(exec).not.toHaveBeenCalled();
      const result = out as { status: string; message: string };
      expect(result.status).toBe('blocked');
      expect(result.message).toContain('query_order_status');
      expect(h.records[0]?.status).toBe('blocked');
      expect(h.records[0]?.output).toContain('query_order_status');
    });

    it('闸门在 → 完全接管判断（老逻辑的 approvals 不再参与）', async () => {
      const exec = vi.fn(async () => ({ ok: true }));
      // approvals 是空的 —— 按老逻辑会被拦下，但闸门说放行就该放行
      const h = gateHarness({ kind: 'allow', missionId: null, nodeId: null }, {});
      const set = buildToolSet([resolved(fakeTool({ execute: exec }), true)], h.runtime);

      const out = await callTool(set, 'fake_tool', { value: 'x' });

      expect(exec).toHaveBeenCalledTimes(1);
      expect(out).toEqual({ ok: true });
    });

    it('闸门拿到的上下文带工具名 / 实现 key / 敏感标记', async () => {
      const h = gateHarness({ kind: 'allow', missionId: null, nodeId: null });
      const set = buildToolSet([resolved(fakeTool(), true)], h.runtime);

      await callTool(set, 'fake_tool', { value: 'x' });

      expect(h.gateCalls[0]).toEqual({
        toolName: 'fake_tool',
        builtin: 'fake_tool',
        sensitive: true,
      });
    });
  });
});
