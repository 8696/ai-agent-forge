import { embedOne } from './embedding';
import { bm25Search, type Bm25Hit } from './bm25';
import { vectorSearch, type VectorHit } from './qdrant';
import {
  logRerankDegrade,
  normalizeRerankScores,
  rerank,
  resolveRerankConfig,
  type RerankConfig,
  type RerankScore,
} from './rerank';
import { logger } from '../logger';

/**
 * 混合检索：向量召回 + BM25 关键词召回，用 RRF 融合 —— 详见 docs/07-c-模块-rag记忆状态协议.md
 *
 * 流程：
 *   query → embedding → Qdrant 向量召回 ┐
 *          query → BM25 关键词召回      ┴→ RRF 融合排序 → [重排] → topK
 *
 * **为什么用 RRF 而不是把两边分数加权求和**：
 *   cosine 相似度在 [0,1]、BM25 分无上界，两者量纲完全不同，任何加权系数都是拍脑袋，
 *   换个语料就得重调。RRF（Reciprocal Rank Fusion, Cormack et al. 2009）只用**排名**不用分数，
 *   天然免疫量纲问题，是「多个异构召回器合并」的标准做法。
 *
 * **重排在哪一环**：RRF 融合之后、截断 topK 之前。RRF 只用排名不用分数，
 * 对语义相关性的判别力有限；重排模型把 query 和候选逐条对读再打分（docs/07-c 模块 09）。
 * **重排不可用就降级回纯 RRF**，检索整体不能因为它挂掉。
 *
 * **score 语义**（前端务必看这段）：
 *   重排生效时 = 重排分（模型给的原始分，落进 [0,1]；原始分超出范围时按批次 min-max 归一化）
 *   降级 / 未启用时 = 归一化到 [0,1] 的 RRF 分，除以双源理论满分 2/(k+1)，
 *     1.0 = 两路都排第一，0.5 = 只有一路排第一。
 *   两种情况下都是「1.0 = 最相关」，可以直接拿来画进度条。
 *   `rrf_score` 始终是原始 RRF 分（量级 ~0.016~0.033），`rerank_score` 是重排原始分。
 */

/** RRF 平滑常数（论文与 Elasticsearch 默认都取 60） */
const RRF_K = 60;

/** 每路各自多召回一些再融合。只取 topK 再融合会浪费掉「第二路补充」的价值 */
const CANDIDATE_MULTIPLIER = 3;

/**
 * 送给重排模型的单条候选文本上限（字符）。
 *
 * 默认拆块是 800 字，正常碰不到这个上限；留着是为了防「有人把 CHUNK_SIZE 调到几万」
 * 时把重排请求撑成几 MB（20 个候选 × 几万字）—— 请求体太大既慢又贵，
 * 而重排本来也只看开头那几百字。
 */
const RERANK_DOC_CHARS = 2000;

export type RecallSource = 'vector' | 'bm25';

export interface HybridHit {
  doc_id: string;
  chunk_index: number;
  /** 文档标题（= 上传时的文件名） */
  source: string;
  text: string;
  /** 相关度 [0,1]，1.0 = 最相关。重排生效时是重排分，否则是归一化 RRF 分。UI 展示用这个 */
  score: number;
  /** 原始 RRF 分（量级 ~0.016~0.033），需要精确对比时用 */
  rrf_score: number;
  /**
   * 重排模型给的原始相关度分；null = 这一条没经过重排
   * （降级 / 未启用 / 候选池外的尾巴）
   */
  rerank_score: number | null;
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
  /**
   * 可选：某一路召回失败时回调一次，带上失败原因。
   *
   * 为什么需要：两路各自 try/catch，**全挂时 hybridSearch 返回 [] 而不是抛错**。
   * 对检索测试页来说这是对的（能看另一半结果），但对话链路光看返回值分不出
   * 「库是空的」「查询太泛」「Qdrant 挂了」这三种情况 ——
   * 少了这个回调，一次明显的故障在用户眼里就变成「AI 突然变无知了」，运营无从排查。
   *
   * 可选参数，不传就是原来的行为；admin 检索测试页不受影响。
   */
  onRecallFailure?: (source: RecallSource, err: unknown) => void;
  /**
   * 租户级重排开关（docs/12-c §C4 的 `rerank_enabled`）。
   * 不传 = 跟随平台默认（开）。租户关掉后这次检索走纯 RRF 排序。
   *
   * 平台总开关（RERANK_ENABLED）是硬边界：它关掉时租户配的「开」也无效。
   */
  rerankEnabled?: boolean | undefined;
}

export async function hybridSearch(params: HybridSearchParams): Promise<HybridHit[]> {
  const candidateK = params.topK * CANDIDATE_MULTIPLIER;

  // 两路各自 try/catch：向量库挂了就只剩关键词召回，关键词索引没重建就只剩向量召回。
  // 检索测试页是管理员排查索引质量的地方，任何一路挂掉都应该还能看到另一半的结果。
  const [vectorHits, bm25Hits] = await Promise.all([
    recallByVector(params.query, params.tenantId, candidateK, params.onRecallFailure),
    recallByKeyword(params.query, params.tenantId, candidateK, params.onRecallFailure),
  ]);

  // 融合 → 重排 → 截断。重排在截断之前：候选池越大，重排能纠正的范围越大。
  const candidates = fuseAll(vectorHits, bm25Hits);
  return rerankAndTrim(params.query, candidates, params.topK, {
    tenantEnabled: params.rerankEnabled,
  });
}

/**
 * 重排 + 截断 —— 单独导出是为了能绕开召回直接单测这一段。
 *
 * **降级语义**：重排服务调不通（网络错误 / 超时 / 响应格式不对）时，
 * 这里 catch 住并原样返回 RRF 顺序 —— 检索整体不能因为重排挂掉。
 * 降级只影响**排序质量**，不影响「有没有召回到」。
 */
export async function rerankAndTrim(
  query: string,
  candidates: HybridHit[],
  topK: number,
  opts?: { tenantEnabled?: boolean | undefined; config?: RerankConfig | undefined },
): Promise<HybridHit[]> {
  const base = opts?.config ?? resolveRerankConfig();
  // 两层开关取「与」：平台总开关是硬边界，租户只能在平台允许的范围里再关一次
  const cfg: RerankConfig = {
    ...base,
    enabled: base.enabled && (opts?.tenantEnabled ?? true),
  };

  // 没开 / 没配地址 / 压根没候选 —— 都直接走纯 RRF
  if (!cfg.enabled || cfg.apiUrl === '' || candidates.length === 0) {
    return trimAndScore(candidates, topK);
  }

  // 候选池至少要盖住 topK —— 否则重排只排了前 N 条，剩下的还得靠 RRF 兜，
  // 两套排序混在一张列表里反而看不懂
  const poolSize = Math.max(cfg.candidates, topK);
  const pool = candidates.slice(0, poolSize);

  try {
    const scores = await rerank(
      query,
      pool.map((hit) => hit.text.slice(0, RERANK_DOC_CHARS)),
      cfg,
    );
    const reranked = applyRerankScores(pool, scores);
    // 候选池之外的尾巴（topK 大于候选池时）按原 RRF 顺序接在后面
    return trimAndScore([...reranked, ...candidates.slice(poolSize)], topK);
  } catch (err: unknown) {
    logRerankDegrade(err, { top_k: topK, candidate_count: candidates.length });
    return trimAndScore(candidates, topK);
  }
}

/**
 * 按重排分重排候选池。
 *
 * 服务没返回的候选（部分服务会丢掉低分项）排在最后，保持原有相对顺序 ——
 * 宁可保守，也不要把没被评过分的块排到前面。
 */
function applyRerankScores(pool: HybridHit[], scores: RerankScore[]): HybridHit[] {
  const byIndex = new Map<number, number>();
  for (const s of scores) {
    if (!byIndex.has(s.index)) {
      byIndex.set(s.index, s.score);
    }
  }
  return pool
    .map((hit, i) => ({ hit, i, score: byIndex.get(i) }))
    .sort((a, b) => {
      if (a.score === undefined && b.score === undefined) return a.i - b.i;
      if (a.score === undefined) return 1;
      if (b.score === undefined) return -1;
      return b.score - a.score || a.i - b.i;
    })
    .map(({ hit, score }) => ({ ...hit, rerank_score: score ?? null }));
}

/**
 * 截断到 topK 并算好展示用的 score。
 *
 * score 有两套来源，混在一张列表里时按「这一条有没有被重排」区分：
 *  - 重排过的 → 重排分（必要时按批次 min-max 归一化到 [0,1]）
 *  - 没重排的 → 归一化 RRF 分（1.0 = 两路都排第一，0.5 = 只有一路排第一）
 */
function trimAndScore(hits: HybridHit[], topK: number): HybridHit[] {
  const trimmed = hits.slice(0, topK);
  const maxRrf = 2 / (RRF_K + 1);
  const rerankedScores = normalizeRerankScores(
    trimmed.filter((h) => h.rerank_score !== null).map((h) => h.rerank_score as number),
  );
  let i = 0;
  return trimmed.map((hit) => {
    if (hit.rerank_score !== null) {
      const value = rerankedScores[i] ?? 0;
      i += 1;
      return { ...hit, score: value };
    }
    return { ...hit, score: Math.min(1, hit.rrf_score / maxRrf) };
  });
}

/** 供单元测试直接验证融合逻辑，不碰网络 */
export function fuse(
  vectorHits: VectorHit[],
  bm25Hits: Bm25Hit[],
  topK: number,
): HybridHit[] {
  return trimAndScore(fuseAll(vectorHits, bm25Hits), topK);
}

/**
 * 融合两路召回结果（不截断）—— RRF 排序后的完整候选列表。
 *
 * 截断交给上层：重排要在「RRF 排完之后、截断 topK 之前」做，
 * 所以这里必须给出一个没有被截断的列表。
 */
function fuseAll(vectorHits: VectorHit[], bm25Hits: Bm25Hit[]): HybridHit[] {
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
          rerank_score: null,
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
  return results;
}

async function recallByVector(
  query: string,
  tenantId: string,
  topK: number,
  onFailure?: (source: RecallSource, err: unknown) => void,
): Promise<VectorHit[]> {
  try {
    const vector = await embedOne(query);
    return await vectorSearch({ tenantId, vector, topK });
  } catch (err: unknown) {
    logger.warn(
      { tenantId, err: err instanceof Error ? err.message : String(err) },
      '向量召回失败，本次只用 BM25 结果',
    );
    onFailure?.('vector', err);
    return [];
  }
}

function recallByKeyword(
  query: string,
  tenantId: string,
  topK: number,
  onFailure?: (source: RecallSource, err: unknown) => void,
): Bm25Hit[] {
  try {
    return bm25Search({ tenantId, query, topK });
  } catch (err: unknown) {
    logger.warn(
      { tenantId, err: err instanceof Error ? err.message : String(err) },
      'BM25 召回失败，本次只用向量结果',
    );
    onFailure?.('bm25', err);
    return [];
  }
}

function hitKey(docId: string, chunkIndex: number): string {
  return `${docId}#${chunkIndex}`;
}