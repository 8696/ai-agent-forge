import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText, stepCountIs, tool, type ToolSet } from 'ai';
import { hybridSearch } from '../rag/hybrid-search';
import { logger } from '../logger';
import type { TraceHandle } from '../services/trace';
import type { ResolvedLlmSettings } from '../services/llm-settings';
import { subAgentTools, type SubAgentDefinition } from './subagents';

/**
 * 子代理执行引擎 —— B6 多代理协作
 *
 * ## 一次委派做了什么
 *
 * 1. 起一个**子 span**（挂在主 agent 的 `llm.generate` span 下）→ 调用树
 * 2. 注入**共享状态**（别的子代理已经查到的信息）→ 子代理之间不用主 agent 转述
 * 3. 按需**检索知识库**（政策类代理要，事实类不要）
 * 4. 跑一次**非流式** `generateText`（子代理的产出是一段结论，不是逐字流）
 * 5. 失败**不抛出去** —— 返回 `{ok:false}`，主 agent 看到的是「这个子代理没跑通」，
 *    可以换个路子继续（**任一子代理失败不拖垮整轮**）
 */

/** 单个子代理的超时（毫秒） */
export const SUB_AGENT_TIMEOUT_MS = 30_000;

/**
 * 子代理的输出上限（比对话短 —— 它只出结论，不出长篇）。
 *
 * ⚠️ **不能给小了**（2026-10-26 实测踩到）：推理型模型（glm-5.3 等）
 *    的**思考 token 全额算输出 token** —— 给 1024 的话，
 *    模型刚想完就到顶了，正文一个字都没吐出来（`output_chars = 0`）。
 *    跟记忆抽取那条（`MIN_EXTRACT_OUTPUT_TOKENS = 2000`）是同一个坑。
 */
const SUB_AGENT_MAX_OUTPUT_TOKENS = 2000;

/** 政策类代理检索知识库时取几条 */
const SUB_AGENT_RETRIEVAL_TOP_K = 5;

export interface SubAgentOutcome {
  ok: boolean;
  /** 成功时的结论正文 */
  output: string;
  /** 失败时的原因 */
  error?: string;
  /** 这一步的 trace span id（写进 `agent_steps.span_id`） */
  spanId: string | null;
}

/**
 * 把共享状态渲染成提示词的一段。
 *
 * ⚠️ **这是「子代理之间通过共享状态协作」的落点** ——
 *    引擎直接把别的子代理的产出塞进来，**不是主 agent 转述一遍**。
 */
export function renderSharedState(state: Record<string, unknown>): string {
  const entries = Object.entries(state).filter(([, v]) => v !== null && v !== undefined);
  if (entries.length === 0) {
    return '';
  }
  const lines = entries.map(([agent, output]) => {
    const text = typeof output === 'string' ? output : JSON.stringify(output);
    return `- 【${agent}】${text.length > 800 ? `${text.slice(0, 800)}…` : text}`;
  });
  return (
    '\n\n## 共享状态（其他子代理已经查到的信息 —— 直接用，别重复查）\n' +
    lines.join('\n')
  );
}

/** 组装子代理的系统提示词 */
export function buildSubAgentSystem(
  agent: SubAgentDefinition,
  sharedState: Record<string, unknown>,
): string {
  return agent.systemPrompt + renderSharedState(sharedState);
}

/**
 * 跑一个子代理。
 *
 * @param parentSpanId 主 agent 的 llm span id —— 子代理的 span 挂在它下面（调用树）
 */
export async function runSubAgent(params: {
  tenantId: string;
  agent: SubAgentDefinition;
  task: string;
  sharedState: Record<string, unknown>;
  llm: ResolvedLlmSettings;
  trace: TraceHandle | null;
  parentSpanId: string | null;
}): Promise<SubAgentOutcome> {
  const span = params.trace?.span(
    'agent.delegate',
    'agent',
    { agent: params.agent.key, task: params.task },
    params.parentSpanId,
  );

  try {
    // ---- 工具：只给非敏感的（subAgentTools 内部已剔除敏感实现）----
    const impls = subAgentTools(params.agent);
    const tools: ToolSet = {};
    for (const impl of impls) {
      tools[impl.key] = tool({
        description: impl.description,
        inputSchema: impl.inputSchema,
        execute: async (args: unknown) =>
          impl.execute(
            { tenantId: params.tenantId, sessionId: null, userId: null },
            args,
          ),
      });
    }

    // ---- 知识库检索（政策类代理要）----
    let context = '';
    if (params.agent.retrieve) {
      try {
        const hits = await hybridSearch({
          query: params.task,
          tenantId: params.tenantId,
          topK: SUB_AGENT_RETRIEVAL_TOP_K,
          rerankEnabled: params.llm.rerankEnabled,
        });
        context = hits.map((h) => `【${h.source}】${h.text}`).join('\n\n');
      } catch (err: unknown) {
        // 检索挂了不该让整个子代理失败 —— 降级成「没有参考资料」
        logger.warn(
          { err, agent: params.agent.key },
          '子代理检索知识库失败，降级为无参考资料',
        );
      }
    }

    const system = buildSubAgentSystem(params.agent, params.sharedState);
    const client = createAnthropic({
      apiKey: params.llm.apiKey,
      baseURL: params.llm.baseUrl,
    });

    const result = await generateText({
      model: client(params.llm.model),
      system: context === '' ? system : `${system}\n\n## 可参考资料\n${context}`,
      messages: [{ role: 'user', content: params.task }],
      temperature: 0,
      maxOutputTokens: SUB_AGENT_MAX_OUTPUT_TOKENS,
      abortSignal: AbortSignal.timeout(SUB_AGENT_TIMEOUT_MS),
      // ⚠️ maxRetries: 0 —— 重试统一由 withRetry 负责（带抖动，见 src/lib/retry.ts）
      maxRetries: 0,
      // ⚠️ **stopWhen 必须显式给**（2026-10-26 实测踩到）：
      //    `generateText` 的默认是 `stepCountIs(1)` —— **一轮就停**。
      //    子代理的模型通常先调工具再作答，默认值下它调完工具就结束了，
      //    **正文一个字都没吐出来**（`result.text` 是空串）。
      //    给 3 轮：够「调工具 → 看结果 → 作答」走完。
      stopWhen: stepCountIs(3),
      ...(Object.keys(tools).length > 0 ? { tools } : {}),
    });

    const output = result.text.trim();
    span?.end({
      agent: params.agent.key,
      output_chars: output.length,
      input_tokens: result.usage.inputTokens ?? 0,
      output_tokens: result.usage.outputTokens ?? 0,
    });
    return { ok: true, output, spanId: span?.id ?? null };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err, agent: params.agent.key }, '子代理执行失败');
    span?.fail(err);
    // ⚠️ **不抛出去** —— 主 agent 看到「这个子代理没跑通」，整轮还能继续
    return { ok: false, output: '', error: message, spanId: span?.id ?? null };
  }
}
