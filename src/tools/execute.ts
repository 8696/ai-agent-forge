import { tool, type ToolSet } from 'ai';
import { logger } from '../logger';
import type { SpanHandle } from '../services/trace';
import type { BuiltinToolContext } from './builtin/registry';
import type { ResolvedTool } from './resolve';
import { approvalKey } from './approval-key';
import type { GateDecision } from '../workflows/types';

/**
 * 工具执行包装层 —— docs/12-b-需求-ai对话能力.md §B3 / §B5
 *
 * 每一层要做的事（12-b §B3 的验收口径全在这儿）：
 *
 *  | 验收口径                  | 这里的做法                                        |
 *  |---------------------------|---------------------------------------------------|
 *  | 工具调不通不中断整轮      | 异常 → 转成 tool result 字符串回灌                 |
 *  | 每次工具调用写一条 span    | `tool.invoke` span（kind='step'）——**覆盖全部路径** |
 *  | 每次外部往返都要有超时    | `TOOL_TIMEOUT_MS`（超时也降级，不重试）            |
 *  | 敏感操作要先人工确认      | 闸门拦下 → 返回 `awaiting_confirmation`            |
 *
 * ⚠️ **span 在 HITL 闸门之前开**（2026-10-26 补）：被闸门拦下（awaiting_confirmation）
 *    和用户拒绝（rejected）这两条路径原先没有 span，与「每次工具调用写一条 span」
 *    的验收口径对不上。现在这五条路径都有：
 *    正常执行 / 超时 / 抛错 / 被闸门拦下 / 用户拒绝。
 *
 * ## 闸门是谁在做决定
 *
 * - 注入了 `runtime.gate`（B5 工作流闸门）→ **它完全接管**判断。
 *   引擎内部已经覆盖了 B3 的敏感工具规则，还多了「前置步骤没做完 → 拦住并告诉模型先做什么」。
 * - 没注入（单测直接构造 runtime）→ 走这里的内联老逻辑。
 *
 * 两者对同一批情况的判断是一致的，所以切换不会改变既有行为。
 */

// 审批键在独立模块（跟工作流引擎共用）—— 这里转出去一份，兼容既有 import
export { approvalKey, hashArgs, stableStringify } from './approval-key';

/** 单次工具调用的超时（毫秒）。跟重排一样：超时降级，不重试 */
export const TOOL_TIMEOUT_MS = 5_000;

/**
 * 闸门回调 —— 问引擎「这一步能不能走」。
 *
 * ⚠️ 类型放在这里而不是引擎文件里：`execute.ts` 是工具层，不该依赖工作流实现。
 */
export type ToolGate = (input: {
  /** 模型调用的注册名 */
  toolName: string;
  /** 内置实现 key */
  builtin: string;
  args: unknown;
  /** 该工具是否敏感 */
  sensitive: boolean;
}) => Promise<GateDecision>;

/** 一次工具调用的记录 —— 会写进 `data-tool-call` part 落库 */
export interface ToolCallRecord {
  tool_call_id: string;
  /** 注册名（模型调用的名字） */
  tool_name: string;
  /** 内置实现 key */
  builtin: string;
  /** 模型给的入参 */
  args: unknown;
  /**
   * ok=成功 / error=抛错 / timeout=超时 / awaiting_confirmation=待确认 /
   * rejected=用户拒绝 / **blocked=前置步骤没满足**（B5 工作流闸门）
   */
  status: 'ok' | 'error' | 'timeout' | 'awaiting_confirmation' | 'rejected' | 'blocked';
  /** 工具的返回值（失败时是降级文案） */
  output: unknown;
  /** 失败原因 */
  error: string | null;
  /** 耗时（毫秒） */
  duration_ms: number;
  /** 需要用户确认时，模型该问什么 */
  confirm_hint?: string;
}

/** 工具运行时 —— 由对话链路注入（哪些副作用由它提供） */
export interface ToolRuntime {
  tenantId: string;
  sessionId: string | null;
  userId: string | null;
  /** 这一轮 assistant 消息的 id（写工具调用流水用） */
  messageId?: string | null | undefined;
  /**
   * 已批准的敏感工具键（会话级）。
   * 键的格式见 `approvalKey()` —— 工具名 + 入参指纹。
   */
  approvals: ReadonlySet<string>;
  /**
   * 用户明确**拒绝**过的敏感工具（点了「取消」）。
   * 闸门见到就直接告诉模型「用户拒绝了」，不再问第三次。
   */
  rejections?: ReadonlySet<string> | undefined;
  /**
   * 工具名 → 用户已确认的那份入参。
   *
   * 模型下一轮**改了参数**时，闸门把这个回传给它（「用这组参数再调一次」），
   * 用户就不用为了参数对不上再点一次确认。
   */
  approvedArgs?: ReadonlyMap<string, unknown> | undefined;
  /** 开一条 span；没有 trace 时返回 undefined */
  span: (
    name: string,
    kind: 'step',
    input: Record<string, unknown>,
    /** 父 span 的 id（不给 = 顶层 span） */
    parentSpanId?: string | null,
  ) => SpanHandle | undefined;
  /**
   * 工具调用结束 —— 对话链路在这里写 `data-tool-call` part + 工具调用流水。
   * 可以是异步的（写库），执行层会 await 它，但**写库失败不影响工具结果**。
   */
  onCall: (record: ToolCallRecord) => void | Promise<void>;
  /**
   * 敏感工具**真正执行之后**的回调（闸门放行 → 跑完了）。
   *
   * 用来把「这条批准已经用掉了」记下来 —— 记了之后下一轮就不再提醒模型
   * 「请用同样的参数再调一次」。
   */
  onExecuted?: ((toolName: string, args: unknown) => void) | undefined;
  /**
   * **工作流闸门**（B5）—— 问引擎「这一步能不能走」。
   *
   * ⚠️ **注入了它就完全接管闸门判断**（引擎内部已覆盖 B3 的敏感工具规则）。
   *    没注入时走这里 `approvals` / `rejections` 的内联老逻辑。
   */
  gate?: ToolGate | undefined;
  /**
   * 工具**执行成功**之后的回调 —— 记流程进度（B5）。
   *
   * 只有属于某个流程的节点才会带上 `missionId` / `nodeId`；
   * 普通工具这两个是 null，引擎那边会直接跳过。
   */
  onToolSucceeded?: ((info: {
    toolName: string;
    builtin: string;
    args: unknown;
    output: unknown;
    missionId: string | null;
    nodeId: string | null;
  }) => void | Promise<void>) | undefined;
  /** 单次工具调用的超时（毫秒）；不传 = 用 TOOL_TIMEOUT_MS */
  timeoutMs?: number;
  /**
   * 父 span 的 id —— 工具调用的 span 挂在它下面。
   *
   * ⚠️ **不给就是顶层 span** —— 调用树会断（`llm.generate` 和它的工具调用平级）。
   *   B6 多代理的调用树要求「模型调用 → 子代理调用」能看出层级，
   *   所以这里必须传主 agent 的 `llm.generate` span id。
   */
  parentSpanId?: (() => string | null) | undefined;
}

/**
 * 上报一次工具调用（写 part + 写流水）。
 *
 * ⚠️ **上报失败不影响工具结果** —— 观测是旁路，它挂了不该让用户的对话失败
 * （跟 trace / 成本记账一个道理）。
 */
async function reportCall(runtime: ToolRuntime, record: ToolCallRecord): Promise<void> {
  try {
    await runtime.onCall(record);
  } catch (err: unknown) {
    logger.warn(
      { err, tool: record.tool_name },
      '工具调用上报失败（不影响工具结果）',
    );
  }
}

/** 超时的哨兵值 —— `withTimeout` 超时返回它而不是抛错 */
const TIMEOUT_SENTINEL = Symbol('tool-timeout');

/**
 * 组装交给 `streamText({ tools })` 的工具集合。
 *
 * ⚠️ **AI SDK v7 的入参 schema 字段名是 `inputSchema`**（不是 v1 时代的 `parameters`）。
 */
export function buildToolSet(resolved: ResolvedTool[], runtime: ToolRuntime): ToolSet {
  const set: ToolSet = {};

  for (const item of resolved) {
    const { name, description, impl, requiresConfirmation } = item;
    const timeoutMs = runtime.timeoutMs ?? TOOL_TIMEOUT_MS;

    set[name] = tool({
      description,
      inputSchema: impl.inputSchema,
      execute: async (input: unknown, options: { toolCallId: string }): Promise<unknown> => {
        const started = Date.now();
        const args = input;
        // ---- span：每次工具调用一条 ----
        //
        // ⚠️ **span 必须在 HITL 闸门之前开**（2026-10-26 补）——
        // 「敏感工具被拦下」和「用户已拒绝」这两条路径原先在建立 span 之前就
        // return 了，导致它们只有 `data-tool-call` part、没有 `tool.invoke` span，
        // 与 12-b §B3 的验收口径「每次工具调用写一条 span」对不上。
        // 现在这条 span 覆盖**全部**路径：正常执行 / 超时 / 抛错 / 被闸门拦下 / 用户拒绝。
        const span = runtime.span(
          'tool.invoke',
          'step',
          {
            tool_name: name,
            builtin: impl.key,
            args,
          },
          // 父 span（主 agent 的 llm.generate）—— 不给就是顶层，调用树会断
          runtime.parentSpanId?.() ?? null,
        );
        // ---- 闸门：敏感工具先要用户确认 / 工作流前置步骤 ----
        //
        // 命中时不执行，把「需要确认」当成工具结果回灌 ——
        // 模型看到后会去问用户「确认吗」，用户点了之后再调一次就放行。
        //
        // ⚠️ **注入了工作流闸门（B5）就由它完全接管** —— 它内部已经覆盖了
        //    B3 的敏感工具规则，还多了「前置步骤没做完 → 拦住并告诉模型先做什么」。
        //    没注入闸门（单测直接构造 runtime）时走下面 `approvals` / `rejections`
        //    的内联老逻辑 —— 两边对同一批情况的判断一致。
        const gateDecision: GateDecision | null =
          runtime.gate === undefined
            ? null
            : await runtime.gate({
                toolName: name,
                builtin: impl.key,
                args,
                sensitive: requiresConfirmation,
              });

        if (gateDecision !== null && gateDecision.kind !== 'allow') {
          if (gateDecision.kind === 'await') {
            const record: ToolCallRecord = {
              tool_call_id: options.toolCallId,
              tool_name: name,
              builtin: impl.key,
              args,
              status: 'awaiting_confirmation',
              output: null,
              error: null,
              duration_ms: Date.now() - started,
              confirm_hint: gateDecision.confirmHint,
            };
            span?.end({ status: 'awaiting_confirmation', duration_ms: record.duration_ms });
            await reportCall(runtime, record);
            return {
              status: 'awaiting_confirmation',
              message: gateDecision.message,
              confirm_hint: gateDecision.confirmHint,
              ...(gateDecision.approvedArgs !== undefined
                ? { approved_args: gateDecision.approvedArgs }
                : {}),
            };
          }

          if (gateDecision.kind === 'reject') {
            const record: ToolCallRecord = {
              tool_call_id: options.toolCallId,
              tool_name: name,
              builtin: impl.key,
              args,
              status: 'rejected',
              output: null,
              error: null,
              duration_ms: Date.now() - started,
            };
            span?.end({ status: 'rejected', duration_ms: record.duration_ms });
            await reportCall(runtime, record);
            return {
              status: 'rejected',
              message: gateDecision.message,
            };
          }

          // blocked —— 前置步骤没满足。**不是错误**，是流程约束：
          // 告诉模型「先查什么」，模型就会去查。
          const blockedRecord: ToolCallRecord = {
            tool_call_id: options.toolCallId,
            tool_name: name,
            builtin: impl.key,
            args,
            status: 'blocked',
            output: gateDecision.message,
            error: null,
            duration_ms: Date.now() - started,
          };
          span?.end({ status: 'blocked', duration_ms: blockedRecord.duration_ms });
          await reportCall(runtime, blockedRecord);
          return {
            status: 'blocked',
            message: gateDecision.message,
          };
        }

        if (gateDecision === null && requiresConfirmation) {
          const key = approvalKey(name, args);

          // 用户明确拒绝过 → 如实告诉模型「拒绝了」，别再问第三次
          if (runtime.rejections?.has(key) === true) {
            const record: ToolCallRecord = {
              tool_call_id: options.toolCallId,
              tool_name: name,
              builtin: impl.key,
              args,
              status: 'rejected',
              output: null,
              error: null,
              duration_ms: Date.now() - started,
            };
            // 被闸门拦下不算「工具失败」—— 闸门正常工作，span 正常结束
            span?.end({ status: 'rejected', duration_ms: record.duration_ms });
            await reportCall(runtime, record);
            return {
              status: 'rejected',
              message: '用户已经拒绝执行这个操作。请如实告诉用户，不会执行，也不要重复询问。',
            };
          }

          if (!runtime.approvals.has(key)) {
            // 模型改了参数 —— 把「用户已确认的那组参数」回传给它，
            // 让它用那组参数再调一次（指纹就对了，用户不用再点一次确认）
            const approvedArgs = runtime.approvedArgs?.get(name);
            const hasOther = approvedArgs !== undefined;

            const record: ToolCallRecord = {
              tool_call_id: options.toolCallId,
              tool_name: name,
              builtin: impl.key,
              args,
              status: 'awaiting_confirmation',
              output: null,
              error: null,
              duration_ms: Date.now() - started,
              confirm_hint: hasOther
                ? `「${impl.name}」需要用用户已确认的参数执行（当前参数与确认的不一致）。`
                : `「${impl.name}」会真实产生一条单据，需要用户确认后才能执行。`,
            };
            span?.end({ status: 'awaiting_confirmation', duration_ms: record.duration_ms });
            await reportCall(runtime, record);
            return {
              status: 'awaiting_confirmation',
              message: hasOther
                ? `用户已经确认过这个工具，确认的参数是 ${JSON.stringify(approvedArgs)}。` +
                  `请用这组参数再调用一次本工具，不要用别的参数。`
                : `该操作需要用户确认后才能执行。请把需要确认的内容（参数摘要）告诉用户，` +
                  `等用户明确同意后，再调用一次本工具（参数保持不变）。`,
              confirm_hint: record.confirm_hint,
              ...(hasOther ? { approved_args: approvedArgs } : {}),
            };
          }
        }

        // ---- 执行 ----
        const ctx: BuiltinToolContext = {
          tenantId: runtime.tenantId,
          sessionId: runtime.sessionId,
          userId: runtime.userId,
        };

        try {
          const settled = await withTimeoutImpl(impl.execute(ctx, args), timeoutMs);
          if (settled === TIMEOUT_SENTINEL) {
            const record: ToolCallRecord = {
              tool_call_id: options.toolCallId,
              tool_name: name,
              builtin: impl.key,
              args,
              status: 'timeout',
              output: `工具执行超时（超过 ${timeoutMs}ms），已放弃本次调用`,
              error: 'timeout',
              duration_ms: Date.now() - started,
            };
            span?.end({ status: 'timeout', duration_ms: record.duration_ms });
            await reportCall(runtime, record);
            return record.output;
          }
          if (!settled.ok) {
            // 工具自己抛的错 —— 走下面的 catch（降级成 tool result，不中断整轮）
            throw settled.error;
          }
          const output = settled.value;
          // 敏感工具真的跑完了 → 告诉外面「这条批准用掉了」，
          // 下一轮不用再提醒模型「请再调一次」
          if (requiresConfirmation) {
            runtime.onExecuted?.(name, args);
          }
          // 流程进度（B5）：属于某个流程的节点执行成功 → 记进度、推状态
          if (runtime.onToolSucceeded !== undefined) {
            try {
              await runtime.onToolSucceeded({
                toolName: name,
                builtin: impl.key,
                args,
                output,
                missionId: gateDecision?.missionId ?? null,
                nodeId: gateDecision?.nodeId ?? null,
              });
            } catch (err: unknown) {
              // 记进度失败不该让工具结果作废 —— 跟 reportCall 一个道理
              logger.warn({ err, tool: name }, '流程进度记录失败（不影响工具结果）');
            }
          }
          const record: ToolCallRecord = {
            tool_call_id: options.toolCallId,
            tool_name: name,
            builtin: impl.key,
            args,
            status: 'ok',
            output,
            error: null,
            duration_ms: Date.now() - started,
          };
          span?.end({ status: 'ok', duration_ms: record.duration_ms });
          await reportCall(runtime, record);
          return output;
        } catch (err: unknown) {
          // 工具抛错**不中断整轮** —— 错误信息作为 tool result 回灌，
          // 模型会据此改口说「这个工具没调通」（12-b §B3 验收）
          const message = err instanceof Error ? err.message : String(err);
          const record: ToolCallRecord = {
            tool_call_id: options.toolCallId,
            tool_name: name,
            builtin: impl.key,
            args,
            status: 'error',
            output: `工具调用失败：${message}`,
            error: message,
            duration_ms: Date.now() - started,
          };
          span?.fail(err, { duration_ms: record.duration_ms });
          await reportCall(runtime, record);
          return record.output;
        }
      },
    });
  }

  return set;
}

/**
 * 带超时的执行 —— 超时返回哨兵而不是抛错。
 *
 * ⚠️ 用「settled」包装（把 rejection 转成一个值）而不是直接 race 原始 promise：
 * 超时之后原 promise 仍可能 reject，那样就变成**未处理的 rejection**，
 * 在 Node 里会打印一条 unhandledRejection 警告，污染日志。
 */
type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

async function withTimeoutImpl<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<Settled<T> | typeof TIMEOUT_SENTINEL> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(
        (value) => ({ ok: true, value }) as const,
        (error: unknown) => ({ ok: false, error }) as const,
      ),
      new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
