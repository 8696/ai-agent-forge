import { embedOne } from './embedding';
import { bm25Search, type Bm25Hit } from './bm25';
import { vectorSearch, type VectorHit } from './qdrant';
import { logger } from '../logger';

/**
 * 混合检索：向量召回 + BM25 关键词召回，用 RRF 融合 —— 详见 docs/07-c-模块-rag记忆状态协议.md
 *
 * 流程：
 *   query → embedding → Qdrant 向量召回 ┐
 *          query → BM25 关键词召回      ┴→ RRF 融合排序 → topK
 *
 * **为什么用 RRF 而不是把两边分数加权求和**：
 *   cosine 相似度在 [0,1]、BM25 分无上界，两者量纲完全不同，任何加权系数都是拍脑袋，
 *   换个语料就得重调。RRF（Reciprocal Rank Fusion, Cormack et al. 2009）只用**排名**不用分数，
 *   天然免疫量纲问题，是「多个异构召回器合并」的标准做法。
 *
 * **score 语义**（前端务必看这段）：
 *   `rrf_score` 是原始 RRF 分，单源最高 1/(60+1)≈0.0164，双源最高 2/61≈0.0328 ——
 *   数值很小，**不能**当成相似度画进度条。
 *   `score` 是归一化到 [0,1] 的值（除以双源理论满分 2/(k+1)），
 *   1.0 = 两路都排第一，0.5 = 只有一路排第一。前端展示用这个。
 */

/** RRF 平滑常数（论文与 Elasticsearch 默认都取 60） */
const RRF_K = 60;

/** 每路各自多召回一些再融合。只取 topK 再融合会浪费掉「第二路补充」的价值 */
const CANDIDATE_MULTIPLIER = 3;

export type RecallSource = 'vector' | 'bm25';

export interface HybridHit {
  doc_id: string;
  chunk_index: number;
  /** 文档标题（= 上传时的文件名） */
  source: string;
  text: string;
  /** 归一化到 [0,1] 的相关度，1.0 = 两路都排第一。UI 展示用这个 */
  score: number;
  /** 原始 RRF 分（量级 ~0.016~0.033），需要精确对比时用 */
  rrf_score: number;
  /** 这一条是被哪几路召回的；两路都有 = 向量和关键词都认为它相关 */
  sources: RecallSource[];
  /** 各路的排名（1-based）；未被该路召回则为 null */
  vector_rank: number | null;
  bm25_rank: number | null;
}

export interface HybridSearchParams {
  query: string;
  tenantId: string;
  topK: number;
}

export async function hybridSearch(params: HybridSearchParams): Promise<HybridHit[]> {
  const candidateK = params.topK * CANDIDATE_MULTIPLIER;

  // 两路各自 try/catch：向量库挂了就只剩关键词召回，关键词索引没重建就只剩向量召回。
  // 检索测试页是管理员排查索引质量的地方，任何一路挂掉都应该还能看到另一半的结果。
  const [vectorHits, bm25Hits] = await Promise.all([
    recallByVector(params.query, params.tenantId, candidateK),
    recallByKeyword(params.query, params.tenantId, candidateK),
  ]);

  return fuse(vectorHits, bm25Hits, params.topK);
}

/** 供单元测试直接验证融合逻辑，不碰网络 */
export function fuse(
  vectorHits: VectorHit[],
  bm25Hits: Bm25Hit[],
  topK: number,
): HybridHit[] {
  const fused = new Map<string, HybridHit>();

  const merge = (hits: Array<VectorHit | Bm25Hit>, source: RecallSource): void => {
    hits.forEach((hit, i) => {
      const key = hitKey(hit.doc_id, hit.chunk_index);
      const rank = i + 1;
      const existing = fused.get(key);
      if (existing === undefined) {
        fused.set(key, {
          doc_id: hit.doc_id,
          chunk_index: hit.chunk_index,
          source: hit.source,
          text: hit.text,
          score: 0,
          rrf_score: 1 / (RRF_K + rank),
          sources: [source],
          vector_rank: source === 'vector' ? rank : null,
          bm25_rank: source === 'bm25' ? rank : null,
        });
        return;
      }
      existing.rrf_score += 1 / (RRF_K + rank);
      existing.sources.push(source);
      if (source === 'vector') {
        existing.vector_rank = rank;
      } else {
        existing.bm25_rank = rank;
      }
    });
  };

  merge(vectorHits, 'vector');
  merge(bm25Hits, 'bm25');

  const results = [...fused.values()];
  results.sort(
    (a, b) => b.rrf_score - a.rrf_score || a.doc_id.localeCompare(b.doc_id) || a.chunk_index - b.chunk_index,
  );

  // 绝对归一化：除以「两路都排第一」的理论满分，而不是除以本次最高分。
  // 后者会让任何一次检索的第一名都显示成 1.00，哪怕语料里根本没有真正相关的文档。
  const maxRrf = 2 / (RRF_K + 1);
  return results.slice(0, topK).map((hit) => ({
    ...hit,
    score: Math.min(1, hit.rrf_score / maxRrf),
  }));
}

async function recallByVector(
  query: string,
  tenantId: string,
  topK: number,
): Promise<VectorHit[]> {
  try {
    const vector = await embedOne(query);
    return await vectorSearch({ tenantId, vector, topK });
  } catch (err: unknown) {
    logger.warn(
      { tenantId, err: err instanceof Error ? err.message : String(err) },
      '向量召回失败，本次只用 BM25 结果',
    );
    return [];
  }
}

function recallByKeyword(query: string, tenantId: string, topK: number): Bm25Hit[] {
  try {
    return bm25Search({ tenantId, query, topK });
  } catch (err: unknown) {
    logger.warn(
      { tenantId, err: err instanceof Error ? err.message : String(err) },
      'BM25 召回失败，本次只用向量结果',
    );
    return [];
  }
}

function hitKey(docId: string, chunkIndex: number): string {
  return `${docId}#${chunkIndex}`;
}