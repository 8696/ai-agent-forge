import { config } from '../config';
import { logger } from '../logger';

/**
 * 重排序（Rerank）客户端 —— docs/07-c-模块-rag记忆状态协议.md 模块 09
 *
 * **它在检索链路的哪一环**：RRF 融合**之后**、截断 topK **之前**。
 *   query → 向量召回 ┐
 *          BM25 召回 ┴→ RRF 融合 → [重排] → topK → 进 prompt
 *
 * **为什么 RRF 之后还要再排一次**：RRF 只用**排名**不用分数 —— 一个「两路都排第一、
 * 但语义其实不沾边」的块，跟一个「只在一路排第 3」的块，RRF 分几乎分不出高下
 * （k=60 把差距压得很平，见 hybrid-search.ts 的推导）。重排模型是把 query 和每个候选
 * **放在一起逐条读**再打分，判别力比融合算法强得多，是「召回没问题、排序不对」
 * 这类问题的标准解法。
 *
 * **协议**：Cohere 兼容的 `POST {apiUrl}`，body `{model, query, documents, top_n}`，
 * 响应 `{ results: [{ index, relevance_score }] }`。
 * 自建的 bge-reranker-v2-m3（起一个 Cohere 兼容服务）、硅基流动、Jina、Cohere
 * 都吃这个格式，所以换供应商只改 `.env` 的地址，不用改代码。
 *
 * **失败一律降级**：重排是「锦上添花」，不是「必须有」。调不通就退回纯 RRF 排序，
 * 检索整体不能因为它挂掉（见 hybrid-search.ts 的 rerankAndTrim）。
 */

/** 重排调用失败（网络 / 4xx / 5xx / 响应格式不对） */
export class RerankError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'RerankError';
  }
}

/** 重排配置（平台级 .env + 租户级开关的合并结果） */
export interface RerankConfig {
  /** 平台总开关与租户开关都开着才是 true */
  enabled: boolean;
  /** 重排服务地址（Cohere 兼容端点的**完整** URL） */
  apiUrl: string;
  /** API key；自建服务通常留空 */
  apiKey: string;
  /** 重排模型 id（自建 bge-reranker-v2-m3 一般就填 bge-reranker-v2-m3） */
  model: string;
  /** 单次调用超时（毫秒）—— 超了就降级，不拖住用户请求 */
  timeoutMs: number;
  /** 送多少个候选去重排（RRF 融合后、截断 topK 之前） */
  candidates: number;
}

/** 一条重排结果 */
export interface RerankScore {
  /** 候选在传入数组里的下标 */
  index: number;
  /** 模型返回的原始相关度分（不归一化 —— 有些模型给的是 logits） */
  score: number;
}

/**
 * 解析重排配置（**只管平台级**：总开关 + 地址 + 模型 + 超时 + 候选数）。
 *
 * 租户开关不在这里合并 —— 它由调用方（hybrid-search 的 rerankAndTrim）跟平台开关
 * 取「与」：平台总开关是硬边界，关掉时租户配的「开」也无效。
 *
 * 平台级开关开着但**没配地址**时，等于不重排（enabled=true 但 apiUrl 为空，
 * 调用方看到空地址就跳过）。这样「配好地址即生效」，不用再手动翻一次开关。
 */
export function resolveRerankConfig(): RerankConfig {
  return {
    enabled: config.RERANK.ENABLED,
    apiUrl: config.RERANK.API_URL,
    apiKey: config.RERANK.API_KEY,
    model: config.RERANK.MODEL,
    timeoutMs: config.RERANK.TIMEOUT_MS,
    candidates: config.RERANK.CANDIDATES,
  };
}

/**
 * 调一次重排服务。
 *
 * 不做重试：重排是可选增强，重试只会把延迟翻倍。真调不通就降级（上层 catch）。
 *
 * @throws RerankError 网络错误、非 2xx、或响应格式不符合预期
 */
export async function rerank(
  query: string,
  documents: string[],
  cfg: RerankConfig,
): Promise<RerankScore[]> {
  if (documents.length === 0) {
    return [];
  }

  let response: Response;
  try {
    response = await fetch(cfg.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // 自建服务一般不校验 key，没配就不带这个头（带了空的更怪）
        ...(cfg.apiKey === '' ? {} : { Authorization: `Bearer ${cfg.apiKey}` }),
      },
      body: JSON.stringify({
        model: cfg.model,
        query,
        documents,
        top_n: documents.length,
      }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (err: unknown) {
    throw new RerankError(
      `重排请求失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new RerankError(
      `重排服务返回 ${response.status}：${detail.slice(0, 300)}`,
      response.status,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (err: unknown) {
    throw new RerankError(
      `重排服务响应不是合法 JSON：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return parseRerankResults(payload, documents.length);
}

/**
 * 解析响应体。
 *
 * 格式不对就抛错（→ 上层降级），**不做「尽力而为」的猜测** ——
 * 猜错的下标会把不相干的块排到前面，比不重排更糟。
 */
function parseRerankResults(payload: unknown, docCount: number): RerankScore[] {
  const results = (payload as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) {
    throw new RerankError('重排服务响应里没有 results 数组');
  }

  const out: RerankScore[] = [];
  const seen = new Set<number>();
  for (const item of results) {
    const raw = item as { index?: unknown; relevance_score?: unknown; score?: unknown };
    const index = raw.index;
    // 不同服务叫法不一样：Cohere 兼容的多是 relevance_score，也有直接叫 score 的
    const score = raw.relevance_score ?? raw.score;

    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= docCount) {
      throw new RerankError(`重排服务返回了越界或非法的下标：${String(index)}`);
    }
    if (typeof score !== 'number' || !Number.isFinite(score)) {
      throw new RerankError(`重排服务返回了非法的相关度分：${String(score)}`);
    }
    // 同一下标出现两次 = 服务有问题，取第一条（宁可少排也不要排错）
    if (seen.has(index)) {
      continue;
    }
    seen.add(index);
    out.push({ index, score });
  }

  if (out.length === 0) {
    throw new RerankError('重排服务返回了空结果');
  }
  return out;
}

/**
 * 把重排分换算成展示用的「相关度」[0,1]。
 *
 * - 分数本身就在 [0,1]（Cohere 兼容的 bge-reranker 就是这样）→ **原样用**，
 *   这样 0.8 就是真的 0.8，不同检索之间可比
 * - 分数超出 [0,1]（部分模型给的是 logits）→ 在本批次内做 min-max 归一化。
 *   没有绝对刻度可用时，相对刻度是唯一能表达「谁更相关」的办法
 * - 全部一样（max === min）→ 没有区分度就别假装有：多条都给 0；
 *   只有一条时它是唯一候选也就是第一名，给 1（显示 0.00 会让人以为「完全不相关」）
 */
export function normalizeRerankScores(scores: number[]): number[] {
  if (scores.length === 0) {
    return [];
  }
  if (scores.every((s) => s >= 0 && s <= 1)) {
    return scores;
  }
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  if (max === min) {
    return scores.map(() => (scores.length === 1 ? 1 : 0));
  }
  return scores.map((s) => (s - min) / (max - min));
}

/** 记一条 warn：重排失败但检索整体还活着（降级日志统一在这里打） */
export function logRerankDegrade(err: unknown, context: Record<string, unknown>): void {
  logger.warn(
    { ...context, err: err instanceof Error ? err.message : String(err) },
    '重排失败，本次降级为纯 RRF 排序',
  );
}
