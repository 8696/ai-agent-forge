import { vectorSearch } from './search';
import type { ScoredPoint } from './qdrant';
import { bm25Search, type Bm25Hit } from './bm25';
import { logger } from '../logger';

/**
 * 混合检索统一入口 —— 详见 docs/16-b §B2 + docs/15 §Step 5
 *
 * 流程：
 *  1. embedOne(query)                                       （已有 src/rag/embedding.ts）
 *  2. 并行跑：vectorSearch(limit=topK*2) + bm25Search(topK*2)
 *  3. RRF（Reciprocal Rank Fusion, k=60）融合
 *  4. 截断 topK 返回
 *
 * 设计要点：
 *  - score 语义：RRF 分（Cormack 2009, k=60），**不是** cosine similarity
 *    单源时 RRF 范围 [0, 1/(k+1)] ≈ [0, 0.016]；两源都命中时最大 ≈ 0.032
 *    跟旧 vectorSearch 的 cosine [0, 1] 不可比；前端 score_threshold 已不再适用
 *  - 唯一键：${docId}::${chunkIndex}（同一 chunk 两边都命中 → RRF 累加）
 *  - sources 字段告诉前端「这条为什么命中」（vector / bm25 / 两者都）
 *  - **rerank 本期跳过**（用户决定，避开 transformers.js / 独立 BGE 服务），Step 6+ 再加
 */

export interface HybridHit {
  doc_id: string;
  chunk_index: number;
  text: string;
  source: string;
  tenant_id: string;
  /** RRF 分（不是 cosine similarity；范围跟旧 score_threshold 不可比） */
  score: number;
  /** 这条命中的来源渠道；多源时累加 RRF 分 */
  sources: Array<'vector' | 'bm25'>;
}

export interface HybridSearchParams {
  query: string;
  tenantId: string;
  topK?: number;
}

interface RrfCandidate {
  doc_id: string;
  chunk_index: number;
  text: string;
  source: string;
  tenant_id: string;
  rrf: number;
  sources: Set<'vector' | 'bm25'>;
}

/**
 * 纯函数：把多路排序结果按 RRF 融合
 *  - rankers：每路是按相关度降序排好的候选
 *  - k：RRF 的常数（Cormack 论文推荐 60）
 *  - 输出：按 RRF 分降序；同分时按 vector 命中优先（更稳定）
 */
export function reciprocalRankFusion(
  rankers: Array<{ name: 'vector' | 'bm25'; hits: Array<{ doc_id: string; chunk_index: number }> }>,
  opts: { k?: number } = {},
): RrfCandidate[] {
  const k = opts.k ?? 60;
  const acc = new Map<string, RrfCandidate>();

  for (const ranker of rankers) {
    const hits = ranker.hits;
    for (let rank = 0; rank < hits.length; rank++) {
      const h = hits[rank];
      if (h === undefined) continue;
      const key = `${h.doc_id}::${h.chunk_index}`;
      let cand = acc.get(key);
      if (cand === undefined) {
        cand = {
          doc_id: h.doc_id,
          chunk_index: h.chunk_index,
          text: '',
          source: '',
          tenant_id: '',
          rrf: 0,
          sources: new Set<'vector' | 'bm25'>(),
        };
        acc.set(key, cand);
      }
      cand.rrf += 1 / (k + rank + 1); // rank 是 0-based，公式用 1-based rank
      cand.sources.add(ranker.name);
    }
  }

  // 按 RRF 降序
  const out = [...acc.values()];
  out.sort((a, b) => b.rrf - a.rrf);
  return out;
}

/** 把 vectorSearch / bm25Search 的 hits 拍平成 RRF 输入（按相关度降序） */
function toRankerInputs(
  vectorResults: ScoredPoint[],
  bm25Results: Bm25Hit[],
): Array<{ name: 'vector' | 'bm25'; hits: Array<{ doc_id: string; chunk_index: number }> }> {
  // vectorResults 已按 cosine desc 排（Qdrant 行为）
  const v = vectorResults.map((r) => ({ doc_id: r.doc_id, chunk_index: r.chunk_index }));
  // bm25Results 已按 BM25 desc 排
  const b = bm25Results.map((r) => ({ doc_id: r.doc_id, chunk_index: r.chunk_index }));
  return [
    { name: 'vector' as const, hits: v },
    { name: 'bm25' as const, hits: b },
  ];
}

/** 把 RRF 候选补回 text/source/tenant_id（用 vectorResults 优先，bm25Results 兜底） */
function hydrateCandidates(
  candidates: RrfCandidate[],
  vectorResults: ScoredPoint[],
  bm25Results: Bm25Hit[],
): HybridHit[] {
  const vMap = new Map<string, ScoredPoint>();
  for (const r of vectorResults) vMap.set(`${r.doc_id}::${r.chunk_index}`, r);
  const bMap = new Map<string, Bm25Hit>();
  for (const r of bm25Results) bMap.set(`${r.doc_id}::${r.chunk_index}`, r);

  return candidates.map((c) => {
    const v = vMap.get(`${c.doc_id}::${c.chunk_index}`);
    const b = bMap.get(`${c.doc_id}::${c.chunk_index}`);
    return {
      doc_id: c.doc_id,
      chunk_index: c.chunk_index,
      text: v?.text ?? b?.text ?? '',
      source: v?.source ?? b?.source ?? '',
      tenant_id: v?.tenant_id ?? b?.tenant_id ?? '',
      score: c.rrf,
      sources: [...c.sources].sort(),
    };
  });
}

/** 混合检索统一入口（Step 5 主交付物；Step 6 的 LLM 调用就直接调这个） */
export async function hybridSearch(params: HybridSearchParams): Promise<HybridHit[]> {
  const { query, tenantId } = params;
  const topK = params.topK ?? 5;
  const candidateLimit = Math.max(topK * 2, 10);

  // 并行：向量检索 + BM25 检索
  const [vectorResults, bm25Results] = await Promise.all([
    vectorSearch({ query, tenantId, topK: candidateLimit }).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn({ tenantId, err: msg }, 'hybridSearch · vector 子路径失败，仅用 BM25');
      return [] as ScoredPoint[];
    }),
    bm25Search({ query, tenantId, topK: candidateLimit }).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn({ tenantId, err: msg }, 'hybridSearch · bm25 子路径失败，仅用 vector');
      return [] as Bm25Hit[];
    }),
  ]);

  const rankers = toRankerInputs(vectorResults, bm25Results);
  const fused = reciprocalRankFusion(rankers, { k: 60 });
  const hydrated = hydrateCandidates(fused, vectorResults, bm25Results);

  const top = hydrated.slice(0, topK);
  logger.debug(
    {
      tenantId,
      query: query.slice(0, 50),
      vecHits: vectorResults.length,
      bm25Hits: bm25Results.length,
      fused: hydrated.length,
      returned: top.length,
    },
    'hybridSearch 完成',
  );
  return top;
}
