import { generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { logger } from '../logger';
import { withTimeout } from '../lib/async';
import { withRetry } from '../lib/retry';

/**
 * 查询改写 —— docs/12-b-需求-ai对话能力.md §B2
 *
 * **把口语化的问题改写成检索友好的形态**：
 *   「我入职三个月能休几天年假」
 *     → 「年假 天数 入职时长 满1年不满10年」
 *
 * 为什么需要：向量化检索靠语义相似度。用户问「我入职三个月能休几天」，
 * 而知识库原文写的是「满1年不满10年的，年假5天」—— 语义接近但不完全重合，
 * 加一层改写能明显提高召回率。
 *
 * ⚠️ **这是可选能力，默认关闭**（租户在「租户设置 → 知识库」里开）：
 *   - 每轮对话会**多一次 LLM 调用**（多 1~3 秒 + 一份 token 花费）
 *   - 收益只在「问法跟原文差很远」时才明显
 *   - 短问题（���假几天」）改写基本没收益，纯属白花钱
 *   所以让租户自己权衡，而不是平台默认给每轮加钱。
 *
 * **失败一律回落原查询** —— 改写是锦上添花，不能因为它挂了就不检索了。
 */
export const QUERY_REWRITE_SYSTEM_PROMPT = `你是一个检索查询改写器。
把用户的问题改写成更适合在企业知识库里做全文检索的查询。

规则：
- 只输出改写后的查询本身，不要解释、不要引号、不要换行
- 保留原问题里的关键实体（制度名、时间、金额、人数）
- 口语化、间接的问法要换成知识库里更可能出现的书面说法
- 补上同义词 / 近义表述（最多 3 个，用空格分隔）
- 问题本身已经清楚时，原样输出（不要硬改）

例：
输入：我入职三个月能休几天年假
输出：年假 天数 入职时长 满1年不满10年`;

/** 改写结果（连同原始查询，供调用方落 span / 调试） */
export interface QueryRewriteResult {
  /** 实际用于检索的查询；改写失败时 == 原查询 */
  effectiveQuery: string;
  /** 模型给出的改写；null = 改写没成功（已回落原查询） */
  rewritten: string | null;
}

export async function rewriteQuery(params: {
  query: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  /** 超时（毫秒）—— 改写不能拖住用户请求 */
  timeoutMs: number;
}): Promise<QueryRewriteResult> {
  const original = params.query;
  try {
    const anthropic = createAnthropic({ apiKey: params.apiKey, baseURL: params.baseUrl });
    // 重试统一由 withRetry 负责（带抖动，见 src/lib/retry.ts）；
    // 外层再套一个 withTimeout —— 改写不能拖住用户请求
    const result = await withTimeout(
      withRetry(
        () =>
          generateText({
            model: anthropic(params.model),
            system: QUERY_REWRITE_SYSTEM_PROMPT,
            messages: [{ role: 'user', content: original }],
            temperature: 0,
            maxOutputTokens: 120,
            maxRetries: 0,
          }),
        {
          maxRetries: 1,
          initialDelayMs: 300,
          onRetry: (attempt, delayMs, err) => {
            logger.warn(
              { attempt, delayMs, err: err instanceof Error ? err.message : String(err) },
              '查询改写失败，准备重试',
            );
          },
        },
      ),
      params.timeoutMs,
      null,
    );
    if (result === null) {
      // 超时了 —— 回落原查询
      logger.warn({ tenantQuery: original }, '查询改写超时，回落原查询');
      return { effectiveQuery: original, rewritten: null };
    }
    const rewritten = result.text.trim().replace(/\s+/g, ' ');
    // 改写结果为空 / 太长 / 跟原问题一样 → 视为没改写成功
    if (rewritten === '' || rewritten.length > 500 || rewritten === original) {
      return { effectiveQuery: original, rewritten: null };
    }
    return { effectiveQuery: rewritten, rewritten };
  } catch (err: unknown) {
    // 改写挂了不影响检索 —— 回落原查询
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      '查询改写失败，回落原查询',
    );
    return { effectiveQuery: original, rewritten: null };
  }
}
