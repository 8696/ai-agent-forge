import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { ToolCallRecord } from './execute';
import { getSubAgent, describeSubAgents, SUB_AGENTS } from '../agents/subagents';
import { runSubAgent } from '../agents/engine';
import { findOrCreateRun, getSharedState, recordStep } from '../services/agent-runs';
import { logger } from '../logger';
import type { TraceHandle } from '../services/trace';
import type { ResolvedLlmSettings } from '../services/llm-settings';

/**
 * `delegate_to_agent` 工具 —— B6 多代理协作（监督者模式）
 *
 * 主 agent 通过调它把子任务派给专业子代理。
 *
 * ⚠️ **这个工具不是租户注册的** —— 它是平台能力，
 *    所以**不进 `tools` 表**、**不出现在「注册工具」下拉框里**。
 *    租户能改的是「自己那些工具的描述」，不是「有几个子代理」。
 */
export function createDelegateTool(params: {
  tenantId: string;
  sessionId: string | null;
  userId: string | null;
  /** 触发这轮对话的 assistant 消息 id —— 用来定位「本轮」的批次 */
  turnId: string;
  /** 本轮的用户问题（写进批次，作为「这摊活是为了什么」） */
  question: string;
  llm: ResolvedLlmSettings;
  trace: TraceHandle | null;
  /** 主 agent 的 llm span id —— 子代理的 span 挂在它下面（调用树） */
  parentSpanId: () => string | null;
  /**
   * 上报这次委派 —— 写 `data-tool-call` part + 工具调用流水。
   *
   * ⚠️ **必须有**：委派虽然不是租户注册的工具，但它**是用户看得见的动作**
   *    （「AI 派了个活给订单代理」）。不报的话前端什么���看不到，
   *    后台的「工具调用记录」里也查不到 —— 出了事没法排查。
   */
  report?: ((record: ToolCallRecord) => void | Promise<void>) | undefined;
}): ToolSet {
  const agentKeys = SUB_AGENTS.map((a) => a.key) as [string, ...string[]];

  return {
    delegate_to_agent: tool({
      description:
        '把一个子任务**委派**给专业子代理去做，它会查完把结论返回给你。' +
        '适合「一个问题需要先分别查好几类信息」的场景 —— 与其自己一个一个查，' +
        '不如派给对应专业的子代理。' +
        '一次只派一个子代理，拿到结果再决定下一步。\n' +
        '可用子代理：\n' +
        describeSubAgents(),
      inputSchema: z.object({
        agent: z.enum(agentKeys, { message: '没有这个子代理' }),
        task: z.string().trim().min(1, '说清楚要它查什么').max(1000),
      }),
      execute: async (
        input: unknown,
        options?: { toolCallId?: string },
      ): Promise<unknown> => {
        const { agent, task } = input as { agent: string; task: string };
        const started = Date.now();
        const def = getSubAgent(agent);
        if (def === undefined) {
          return { status: 'error', message: `没有叫「${agent}」的子代理` };
        }

        // 本轮的批次（第一次派活时创建；同轮再派活就是同一个批次 → 共享状态互通）
        const run = await findOrCreateRun({
          tenantId: params.tenantId,
          sessionId: params.sessionId,
          userId: params.userId,
          turnId: params.turnId,
          question: params.question,
        });

        // 共享状态 = 别的子代理已经查到的信息（**引擎直接注入**，不是主 agent 转述）
        const sharedState = await getSharedState(params.tenantId, run.id);

        // ---- 这次委派自己的 tool.invoke span ----
        //
        // 委派不是租户注册的工具，走不到 `buildToolSet` 那层包装，
        // 所以这里**自己开一个** —— 否则调用树里只有 agent.delegate，
        // 少了一层「模型调了这个工具」的语义。
        const toolSpan = params.trace?.span(
          'tool.invoke',
          'step',
          { tool_name: 'delegate_to_agent', builtin: 'delegate_to_agent', args: { agent: def.key, task } },
          params.parentSpanId(),
        );

        const outcome = await runSubAgent({
          tenantId: params.tenantId,
          agent: def,
          task,
          sharedState,
          llm: params.llm,
          trace: params.trace,
          // 子代理的 span 挂在**这次委派**下面（不是挂在 llm.generate 下面）
          parentSpanId: toolSpan?.id ?? params.parentSpanId(),
        });

        toolSpan?.end({
          agent: def.key,
          status: outcome.ok ? 'ok' : 'failed',
          duration_ms: Date.now() - started,
        });

        // ⚠️ **记步骤失败不能拖垮整轮** —— 步骤只是账本，写不进去不该让主 agent 这一轮挂掉
        try {
          await recordStep({
            tenantId: params.tenantId,
            runId: run.id,
            agent: def.key,
            task,
            output: outcome.output,
            state: outcome.ok ? 'ok' : 'failed',
            error: outcome.error ?? null,
            spanId: outcome.spanId,
          });
        } catch (err: unknown) {
          logger.warn({ err, agent: def.key }, '子代理步骤落库失败（不影响主流程）');
        }

        // 上报这次委派 → 前端能看到「AI 派了个活给 XX 代理」
        if (params.report !== undefined) {
          try {
            await params.report({
              tool_call_id: options?.toolCallId ?? `delegate-${Date.now()}`,
              tool_name: 'delegate_to_agent',
              builtin: 'delegate_to_agent',
              args: { agent: def.key, task },
              status: outcome.ok ? 'ok' : 'error',
              output: outcome.ok ? outcome.output : `子代理「${def.name}」失败：${outcome.error ?? ''}`,
              error: outcome.ok ? null : (outcome.error ?? '未知原因'),
              duration_ms: Date.now() - started,
            });
          } catch (err: unknown) {
            logger.warn({ err }, '委派上报失败（不影响主流程）');
          }
        }

        if (!outcome.ok) {
          // ⚠️ **失败不抛出去** —— 主 agent 看到「这个子代理没跑通」，
          //    可以换个子代理或自己接着做（任一子代理失败不拖垮整轮）
          return {
            status: 'failed',
            agent: def.key,
            message:
              `子代理「${def.name}」执行失败：${outcome.error ?? '未知原因'}。` +
              '你可以换个思路，或者自己直接查。',
          };
        }

        return {
          status: 'ok',
          agent: def.key,
          agent_name: def.name,
          output: outcome.output,
        };
      },
    }),
  };
}
