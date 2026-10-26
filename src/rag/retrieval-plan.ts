import {
  rewriteQuery,
  QUERY_REWRITE_TIMEOUT_MS,
  type QueryRewriteResult,
} from './query-rewrite';

/**
 * 检索计划 —— **线上对话与评测共用同一份口径**
 *
 * ## 为什么要有这个模块
 *
 * B1（线上对话）和 D1（评测）都要求「跑真实链路」：
 * 评测必须用**同一套系统提示词 + 同一套检索 + 同一套模型**，
 * 否则「改坏提示词 → 分数下降」这条验收不成立
 * （docs/12-d-需求-运维稳定.md §D1）。
 *
 * 「同一套检索」包含两件容易被各自实现漏掉的事：
 *  1. **查询改写**（B2 的 `query_rewrite_enabled` 开关）—— 租户开了，线上会先改写再检索
 *  2. **重排**（B2 的 `rerank_enabled` 开关）—— 租户关了，线上走纯 RRF 排序
 *
 * ⚠️ 2026-10-26 之前评测这两样都没跟：
 *  评测只调 `hybridSearch({query, tenantId, topK})` —— 不传 `rerankEnabled`（走平台默认），
 *  也没有改写步骤。租户一旦改了这两个开关，**评测跑的检索就不是线上那一套了**，
 *  分数不能代表线上真实表现。现在两边共用 `planRetrieval()`，口径靠结构保证一致。
 *
 * **两个开关都是租户级的**（docs/12-c §C4）：
 *  - `query_rewrite_enabled` —— 默认关。每轮多一次 LLM 调用（多 1~3 秒 + 一份花费）
 *  - `rerank_enabled` —— 租户可以在平台允许的范围里单独关掉自己的重排
 */

/** 检索计划的输出 */
export interface RetrievalPlan {
  /** 实际用于检索的查询 —— 改写失败时 == 原查询 */
  query: string;
  /** 模型给出的改写；null = 没改写（开关关了，或改写失败回落） */
  rewritten: string | null;
  /**
   * 要不要重排 —— 平台总开关 ∧ 租户开关（`llm.rerankEnabled` 已经是这个值）
   *
   * 透传给 `hybridSearch({ rerankEnabled })`：
   * 传 `false` = 强制走纯 RRF；传 `true` = 仍由平台总开关说了算
   * （`hybridSearch` 那边是 `平台开关 && (租户开关 ?? true)`）。
   *
   * ⚠️ **这里永远是布尔值，不是 `undefined`** —— 少了这个「显式的 false」，
   * 租户关掉重排就关不掉（`undefined` 会被当成「没设，按平台默认走」）。
   */
  rerankEnabled: boolean;
}

/**
 * 按租户开关算出「这次检索该怎么查」。
 *
 * **改写失败一律回落原查询** —— 改写是锦上添花，不能因为它挂了就不检索。
 */
export async function planRetrieval(params: {
  /** 用户的原始问题 */
  query: string;
  /** 租户有没有开查询改写 */
  queryRewriteEnabled: boolean;
  /** 平台总开关 ∧ 租户开关 */
  rerankEnabled: boolean;
  apiKey: string;
  baseUrl: string;
  model: string;
  /** 改写超时（毫秒）—— 默认用 query-rewrite 的那份常量 */
  timeoutMs?: number;
}): Promise<RetrievalPlan> {
  if (!params.queryRewriteEnabled) {
    return { query: params.query, rewritten: null, rerankEnabled: params.rerankEnabled };
  }

  const r: QueryRewriteResult = await rewriteQuery({
    query: params.query,
    apiKey: params.apiKey,
    baseUrl: params.baseUrl,
    model: params.model,
    timeoutMs: params.timeoutMs ?? QUERY_REWRITE_TIMEOUT_MS,
  });

  return { query: r.effectiveQuery, rewritten: r.rewritten, rerankEnabled: params.rerankEnabled };
}
