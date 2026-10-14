import { logger } from '../logger';
import { config } from '../config';
import { getQdrant } from './qdrant';
// nodejieba 是 CommonJS 库，default import 后挂 .cut() / .cutHMM() 等方法
import nodejieba from 'nodejieba';

/**
 * BM25 关键词检索 —— 详见 docs/16-b §B2 + docs/15 §Step 5
 *
 * 设计要点：
 *  - 进程内内存索引（per-tenant Map），BM25 公式自实现
 *  - Tokenize：nodejieba 切词（中文友好：「年假」作为一个语义单元） + unigram + bigram
 *  - Robertson BM25：k1=1.5, b=0.75
 *  - 懒加载：首次 bm25Search 时若租户索引不存在 → Qdrant scroll 该租户所有 points → 重建
 *  - 进程重启就丢索引（与 03-b §B.3「进程内 lru-cache」一致），下次请求触发 ensureIndex 从 Qdrant 重建
 *  - 强制按 tenantId 隔离（与 vectorSearch 同策略，搜索时不许绕过）
 */

export interface Bm25ChunkInput {
  index: number;
  text: string;
  source: string;
}

export interface Bm25Hit {
  doc_id: string;
  chunk_index: number;
  text: string;
  source: string;
  tenant_id: string;
  score: number;
}

interface IndexedDoc {
  key: string; // `${docId}::${chunkIndex}`
  docId: string;
  chunkIndex: number;
  source: string;
  tenantId: string;
  text: string;
  tokens: string[];
  length: number;
}

interface TenantIndex {
  docs: IndexedDoc[];
  /** 该租户所有块的平均 token 数 */
  avgDocLen: number;
  /** 该租户当前总块数 */
  totalDocs: number;
  /** 单调递增；用于判定是否需要重建（未来扩展位） */
  indexVersion: number;
}

// per-tenant 索引
const indexes = new Map<string, TenantIndex>();
// per-tenant "is initialized" 标志（避免重复 ensureIndex 跑多次 scroll）
const initialized = new Set<string>();
// 单调递增的 rebuild token；用于 detect 「ensureIndex 期间被并发 add」（简单方案：lock-free，最后赢）
let globalVersion = 0;

// Robertson defaults
const K1 = 1.5;
const B = 0.75;

function chunkKey(docId: string, chunkIndex: number): string {
  return `${docId}::${chunkIndex}`;
}

/**
 * Tokenize —— nodejieba 切词 + unigram + bigram —— 详见 docs/16-b §B2
 *
 * 流程：
 *  1. U+3000 全角空格 → 半角；lowercase
 *  2. nodejieba.cut(text, true) 切词（HMM=true 处理未登录词）
 *  3. 过滤掉纯标点 / 纯空白 / 纯符号
 *  4. unigram = 切词结果（每个 jieba 词作为整体 unit）
 *  5. bigram = 跨词边界（"年假 5 天" → "年假5" "5天"）+ 词内字符对（"年假" → "年假"）
 *  6. 合并 unigram + bigram 去重
 *
 * 例：
 *  「年假 5 天」        → unigram: 年假, 5, 天   bigram: 年假, 年假5, 5天
 *  「请在请假前 7 天」  → unigram: 请, 在, 请假, 前, 7, 天   bigram: 请在, 在请, 请假, 请假前, 前7, 7天
 *
 * 中文友好（jieba 把"年假"作为一个语义单元而不是拆字）；英文按空格（jieba 不切英文单词）。
 */
export function tokenize(text: string): string[] {
  if (text === '') return [];
  // 1. 规范化（U+3000 全角空格 → 半角）
  const s = text.replace(/\u3000/g, ' ').toLowerCase();

  // 2. jieba 切词
  const rawTokens: string[] = nodejieba.cut(s, true);

  // 3. 过滤：纯标点 / 纯空白 / 纯符号 去掉
  const cleaned: string[] = [];
  for (const t of rawTokens) {
    if (t.length === 0) continue;
    if (/^[\s\p{P}\p{S}]+$/u.test(t)) continue; // \p{P} 标点；\p{S} 符号
    cleaned.push(t);
  }
  if (cleaned.length === 0) return [];

  // 4. unigram = jieba 切词结果
  const unigrams = [...cleaned];

  // 5. bigram：跨词 + 词内
  const bigrams: string[] = [];
  // 跨词：相邻 token 拼接
  for (let i = 0; i + 1 < cleaned.length; i++) {
    const a = cleaned[i];
    const b = cleaned[i + 1];
    if (a === undefined || b === undefined) continue;
    bigrams.push(`${a}${b}`);
  }
  // 词内：长词（≥2 字符）拆字符对（让 BM25 也能匹配拆字 query）
  for (const w of cleaned) {
    if (w.length >= 2) {
      for (let i = 0; i + 1 < w.length; i++) {
        const a = w[i];
        const b = w[i + 1];
        if (a === undefined || b === undefined) continue;
        bigrams.push(`${a}${b}`);
      }
    }
  }

  // 6. 去重
  return [...new Set([...unigrams, ...bigrams])];
}

/** 单文档 token 计数（词频表） */
function termFreq(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) {
    tf.set(t, (tf.get(t) ?? 0) + 1);
  }
  return tf;
}

/** 重建一个租户的索引（从 Qdrant scroll 全量拉，删旧加新） */
function rebuildIndex(tenantId: string, docs: IndexedDoc[]): TenantIndex {
  const total = docs.length;
  let totalLen = 0;
  for (const d of docs) totalLen += d.length;
  const avgDocLen = total === 0 ? 0 : totalLen / total;
  const idx: TenantIndex = {
    docs,
    avgDocLen,
    totalDocs: total,
    indexVersion: ++globalVersion,
  };
  indexes.set(tenantId, idx);
  initialized.add(tenantId);
  return idx;
}

/** 增量加文档（ingest 完成时调） */
export function bm25Add(opts: {
  tenantId: string;
  docId: string;
  chunks: Bm25ChunkInput[];
  source?: string;
}): void {
  const { tenantId, docId, chunks } = opts;
  if (chunks.length === 0) return;
  const idx = indexes.get(tenantId);
  const source = opts.source ?? '';

  const newDocs: IndexedDoc[] = [];
  for (const c of chunks) {
    const tokens = tokenize(c.text);
    if (tokens.length === 0) continue;
    newDocs.push({
      key: chunkKey(docId, c.index),
      docId,
      chunkIndex: c.index,
      source,
      tenantId,
      text: c.text,
      tokens,
      length: tokens.length,
    });
  }
  if (newDocs.length === 0) return;

  // 增量：若该租户已索引 → 先删该 docId 的旧块（重 ingest 场景），再加新的
  let docs = idx?.docs ?? [];
  if (idx !== undefined) {
    docs = docs.filter((d) => d.docId !== docId);
  }
  const merged = [...docs, ...newDocs];
  rebuildIndex(tenantId, merged);
  logger.debug(
    { tenantId, docId, added: newDocs.length, total: merged.length },
    'BM25 索引增量添加',
  );
}

/** 增量删文档（knowledge DELETE 时调） */
export function bm25Remove(opts: { tenantId: string; docId: string }): void {
  const { tenantId, docId } = opts;
  const idx = indexes.get(tenantId);
  if (idx === undefined) return; // 没索引就不管（Qdrant 已经清了，懒加载时会刷一次）
  const before = idx.docs.length;
  const filtered = idx.docs.filter((d) => d.docId !== docId);
  if (filtered.length === before) return;
  rebuildIndex(tenantId, filtered);
  logger.debug({ tenantId, docId, before, after: filtered.length }, 'BM25 索引增量删除');
}

/**
 * 懒加载：从 Qdrant scroll 该租户所有 points → 重建索引
 * 已加载则 no-op；并发同时调也安全（filter 完后写 Map，最后一个赢）
 */
export async function ensureBm25Index(tenantId: string): Promise<void> {
  if (initialized.has(tenantId)) return;
  const q = getQdrant();
  const collection = config.QDRANT_COLLECTION;
  const collected: IndexedDoc[] = [];
  let offset: string | number | null | undefined = undefined;
  try {
    // Qdrant scroll：分页拉所有点，filter by tenant_id
    while (true) {
      const page = (await q.scroll(collection, {
        filter: {
          must: [{ key: 'tenant_id', match: { value: tenantId } }],
        },
        with_payload: true,
        with_vector: false,
        limit: 256,
        ...(offset !== undefined ? { offset } : {}),
      })) as {
        points?: Array<{
          payload?: Record<string, unknown> | null;
        }>;
        next_page_offset?: string | number | null;
      };
      const points = page.points ?? [];
      for (const p of points) {
        const payload = (p.payload ?? {}) as Record<string, unknown>;
        const docId = typeof payload['doc_id'] === 'string' ? payload['doc_id'] : '';
        const chunkIndex =
          typeof payload['chunk_index'] === 'number' ? payload['chunk_index'] : 0;
        const text = typeof payload['text'] === 'string' ? payload['text'] : '';
        const source = typeof payload['source'] === 'string' ? payload['source'] : '';
        if (docId === '' || text === '') continue;
        const tokens = tokenize(text);
        if (tokens.length === 0) continue;
        collected.push({
          key: chunkKey(docId, chunkIndex),
          docId,
          chunkIndex,
          source,
          tenantId,
          text,
          tokens,
          length: tokens.length,
        });
      }
      const next = page.next_page_offset;
      if (next === undefined || next === null) break;
      offset = next;
    }
    rebuildIndex(tenantId, collected);
    logger.info({ tenantId, chunks: collected.length }, 'BM25 索引从 Qdrant 重建完成');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // 重建失败时不标记 initialized（下次请求会再试）
    logger.error({ tenantId, err: msg }, 'BM25 索引重建失败（下次检索会重试）');
    throw e;
  }
}

/** BM25 检索（内部会 ensureIndex；外部一般直接调 hybridSearch） */
export async function bm25Search(opts: {
  query: string;
  tenantId: string;
  topK: number;
}): Promise<Bm25Hit[]> {
  const { query, tenantId, topK } = opts;
  await ensureBm25Index(tenantId);
  const idx = indexes.get(tenantId);
  if (idx === undefined || idx.docs.length === 0) return [];

  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  // 1. 计算 IDF（按整个 query 涉及的 term）
  const idf = new Map<string, number>();
  for (const t of queryTokens) {
    if (idf.has(t)) continue;
    let df = 0;
    for (const d of idx.docs) {
      if (d.tokens.includes(t)) df += 1;
    }
    // Robertson IDF（带 +1 防负数）
    const v = Math.log((idx.totalDocs - df + 0.5) / (df + 0.5) + 1);
    idf.set(t, v);
  }

  // 2. 算每个文档的 BM25 分
  const N = idx.totalDocs;
  const avgDl = idx.avgDocLen > 0 ? idx.avgDocLen : 1;
  const scored: Array<{ doc: IndexedDoc; score: number }> = [];
  for (const d of idx.docs) {
    const tf = termFreq(d.tokens);
    let s = 0;
    for (const t of queryTokens) {
      const f = tf.get(t);
      if (f === undefined || f === 0) continue;
      const idfVal = idf.get(t) ?? 0;
      const tfNorm = (f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.length) / avgDl));
      s += idfVal * tfNorm;
    }
    if (s > 0) scored.push({ doc: d, score: s });
  }

  // 3. 排序 + 截断
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, Math.max(0, topK));
  // 兜底 N 用不到，只是类型需要
  void N;
  return top.map(({ doc, score }) => ({
    doc_id: doc.docId,
    chunk_index: doc.chunkIndex,
    text: doc.text,
    source: doc.source,
    tenant_id: doc.tenantId,
    score,
  }));
}

/** 测试 / 调试用：清空内存索引（不要在生产用） */
export function _resetBm25ForTest(): void {
  indexes.clear();
  initialized.clear();
  globalVersion = 0;
}
