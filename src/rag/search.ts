import { embedOne } from './embedding';
import { getQdrant, type ScoredPoint } from './qdrant';
import { config } from '../config';
import type { Schemas } from '@qdrant/js-client-rest';

/**
 * 向量检索 —— 详见 docs/05-b §5.6 + docs/16-b §B2（RAG 检索）
 *
 * 设计要点：
 *  - 强制按 tenant_id 过滤（防跨租户泄露 —— 写在搜索代码里，不让上层绕过）
 *  - Step 4 暂时只有向量检索；Step 5 加 BM25 + RRF + 重排序
 *  - 输入 1 句话 → 1 个 query embedding → Qdrant.search topK
 *
 * 失败行为：Embedding API 挂了 → 抛 EmbeddingError 让上层 5xx；
 *          Qdrant 不可达 → 抛 QdrantClient 内部错误让上层 5xx。
 */

export interface SearchParams {
  query: string;
  tenantId: string;
  topK?: number;
  /** 可选：原始 score 阈值（cosine similarity，0-1） */
  scoreThreshold?: number;
}

export async function vectorSearch(params: SearchParams): Promise<ScoredPoint[]> {
  const queryEmbedding = await embedOne(params.query);
  const topK = params.topK ?? 5;

  const q = getQdrant();
  // Qdrant v1.26 把 search() 收敛成通用 query()，等价 query='nearest' 走向量检索
  // （参见 node_modules/@qdrant/js-client-rest/dist/types/qdrant-client.d.ts §875）
  const results = await q.query(config.QDRANT_COLLECTION, {
    query: queryEmbedding,
    limit: topK,
    with_payload: true,
    filter: {
      must: [{ key: 'tenant_id', match: { value: params.tenantId } }],
    },
    ...(params.scoreThreshold !== undefined ? { score_threshold: params.scoreThreshold } : {}),
  });

  return (results.points ?? []).map((r: Schemas['ScoredPoint']) => {
    const payload = (r.payload ?? {}) as Record<string, unknown>;
    return {
      doc_id: typeof payload['doc_id'] === 'string' ? (payload['doc_id'] as string) : '',
      chunk_index:
        typeof payload['chunk_index'] === 'number' ? (payload['chunk_index'] as number) : 0,
      text: typeof payload['text'] === 'string' ? (payload['text'] as string) : '',
      tenant_id:
        typeof payload['tenant_id'] === 'string' ? (payload['tenant_id'] as string) : '',
      source: typeof payload['source'] === 'string' ? (payload['source'] as string) : '',
      score: r.score,
    };
  });
}