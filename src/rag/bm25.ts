import nodejieba from 'nodejieba';
import { logger } from '../logger';
import { scrollAllChunks } from './qdrant';

/**
 * BM25 关键词召回（混合检索的第二路）—— 详见 docs/07-c-模块-rag记忆状态协议.md
 *
 * 为什么要有这一路：向量检索擅长「语义相近但用词不同」，但对**专有名词 / 编号 / 人名**
 * 这类精确匹配很不可靠（问「订单 SO-2024-0817 怎么处理」时，向量可能召回一堆语义相近的
 * 订单说明却漏掉这一条）。BM25 补的就是这个洞，两路结果用 RRF 融合。
 *
 * **索引只存在内存里**：进程重启即丢失，所以 server 启动时会调 rebuildFromQdrant()
 * 从 Qdrant 的 payload 把全文拉回来重建（Qdrant 里存了每个 chunk 的原文）。
 * 单机内存索引的定位是「中小语料（几千块）够用」；语料再大一个量级就要换成
 * Elasticsearch / OpenSearch 之类的持久化倒排。
 */

/** BM25 参数：k1 控制词频饱和，b 控制文档长度归一化。用的是教科书默认值 */
const K1 = 1.5;
const B = 0.75;

export interface Bm25Chunk {
  doc_id: string;
  chunk_index: number;
  source: string;
  text: string;
}

export interface Bm25Hit {
  doc_id: string;
  chunk_index: number;
  source: string;
  text: string;
  /** BM25 原始分，无上界；不同查询之间不可比 */
  score: number;
}

interface IndexedChunk extends Bm25Chunk {
  key: string;
  /** 词 → 该块内出现次数 */
  termFreq: Map<string, number>;
  /** 该块分词后的词数（算长度归一化用） */
  length: number;
}

interface TenantIndex {
  chunks: Map<string, IndexedChunk>;
  /** doc_id → 该文档所有块的 key，删文档时按 doc_id 整体清掉 */
  keysByDoc: Map<string, Set<string>>;
  /** 词 → 出现在多少个块里（算 IDF 用） */
  docFreq: Map<string, number>;
  totalLength: number;
}

const indexes = new Map<string, TenantIndex>();

// ===== 对外 API =====

/** 写入 / 覆盖一个文档的全部块（重试索引时先删后写，保证不留残块） */
export function bm25Add(params: {
  tenantId: string;
  chunks: Bm25Chunk[];
}): void {
  const { tenantId, chunks } = params;
  // 先把这次涉及的每个文档的旧块清掉。正常路径只有 1 个 doc_id，
  // 但去重后即使调用方一次喂多个文档也不会漏删。
  for (const docId of new Set(chunks.map((c) => c.doc_id))) {
    bm25RemoveDoc(tenantId, docId);
  }

  const index = getOrCreateIndex(tenantId);
  for (const chunk of chunks) {
    addChunk(index, chunk);
  }
}

/** 删掉某租户下某个文档的全部块 */
export function bm25RemoveDoc(tenantId: string, docId: string): void {
  const index = indexes.get(tenantId);
  if (index === undefined) {
    return;
  }
  const keys = index.keysByDoc.get(docId);
  if (keys === undefined) {
    return;
  }
  for (const key of keys) {
    const chunk = index.chunks.get(key);
    if (chunk === undefined) {
      continue;
    }
    for (const term of chunk.termFreq.keys()) {
      const df = index.docFreq.get(term);
      if (df === undefined) {
        continue;
      }
      if (df <= 1) {
        index.docFreq.delete(term);
      } else {
        index.docFreq.set(term, df - 1);
      }
    }
    index.totalLength -= chunk.length;
    index.chunks.delete(key);
  }
  index.keysByDoc.delete(docId);
}

/**
 * 关键词检索。返回按 BM25 分降序的 topK。
 * 查询分词后一个词都没命中（纯符号 / 全是停用词）时返回空数组，由上层降级到纯向量结果。
 */
export function bm25Search(params: {
  tenantId: string;
  query: string;
  topK: number;
}): Bm25Hit[] {
  const index = indexes.get(params.tenantId);
  if (index === undefined || index.chunks.size === 0) {
    return [];
  }
  const queryTerms = [...new Set(tokenize(params.query))];
  if (queryTerms.length === 0) {
    return [];
  }

  const totalDocs = index.chunks.size;
  const avgLength = index.totalLength / totalDocs;
  const scored: Bm25Hit[] = [];

  for (const chunk of index.chunks.values()) {
    let score = 0;
    for (const term of queryTerms) {
      const tf = chunk.termFreq.get(term);
      if (tf === undefined) {
        continue;
      }
      const df = index.docFreq.get(term) ?? 0;
      // +1 的 IDF 变体：保证 IDF > 0，否则高频词（的 / 是）会拉低总分
      const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
      const norm = 1 - B + (B * chunk.length) / (avgLength || 1);
      score += idf * ((tf * (K1 + 1)) / (tf + K1 * norm));
    }
    if (score > 0) {
      scored.push({
        doc_id: chunk.doc_id,
        chunk_index: chunk.chunk_index,
        source: chunk.source,
        text: chunk.text,
        score,
      });
    }
  }

  // 同分时按文档 id 排，保证结果稳定可复现（否则每次检索顺序都可能抖）
  scored.sort((a, b) => b.score - a.score || a.doc_id.localeCompare(b.doc_id) || a.chunk_index - b.chunk_index);
  return scored.slice(0, params.topK);
}

/** 某租户索引里的块数（测试 / 排错用） */
export function bm25ChunkCount(tenantId: string): number {
  return indexes.get(tenantId)?.chunks.size ?? 0;
}

/** 清空全部租户的索引 */
export function bm25Clear(): void {
  indexes.clear();
}

/**
 * 从 Qdrant 重建全部租户的 BM25 索引。server 启动时调（后台，不阻塞启动）。
 *
 * 拉不到 / 拉一半失败时只丢 BM25 这一路，向量检索照常工作。
 */
export async function rebuildFromQdrant(): Promise<number> {
  bm25Clear();
  let rebuilt = 0;
  try {
    rebuilt = await scrollAllChunks((payload) => {
      addChunk(getOrCreateIndex(payload.tenant_id), {
        doc_id: payload.doc_id,
        chunk_index: payload.chunk_index,
        source: payload.source,
        text: payload.text,
      });
    });
  } catch (err: unknown) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'BM25 索引重建失败，本次只走向量召回',
    );
    return rebuilt;
  }
  logger.info({ chunks: rebuilt }, 'BM25 索引已从 Qdrant 重建');
  return rebuilt;
}

// ===== 内部实现 =====

function getOrCreateIndex(tenantId: string): TenantIndex {
  let index = indexes.get(tenantId);
  if (index === undefined) {
    index = {
      chunks: new Map(),
      keysByDoc: new Map(),
      docFreq: new Map(),
      totalLength: 0,
    };
    indexes.set(tenantId, index);
  }
  return index;
}

function addChunk(index: TenantIndex, chunk: Bm25Chunk): void {
  const key = chunkKey(chunk.doc_id, chunk.chunk_index);
  const terms = tokenize(chunk.text);
  const termFreq = new Map<string, number>();
  for (const term of terms) {
    termFreq.set(term, (termFreq.get(term) ?? 0) + 1);
  }

  index.chunks.set(key, {
    ...chunk,
    key,
    termFreq,
    length: terms.length,
  });
  for (const term of termFreq.keys()) {
    index.docFreq.set(term, (index.docFreq.get(term) ?? 0) + 1);
  }
  index.totalLength += terms.length;

  const keys = index.keysByDoc.get(chunk.doc_id) ?? new Set<string>();
  keys.add(key);
  index.keysByDoc.set(chunk.doc_id, keys);
}

function chunkKey(docId: string, chunkIndex: number): string {
  return `${docId}#${chunkIndex}`;
}

/**
 * 中文 / 英文混合分词。
 *
 * nodejieba 的默认 cut 会把英文单词拆成单个字母（"annual" → a/n/n/u/a/l），
 * 对 BM25 来说是灾难：词表爆炸、常见字母的 IDF 趋近 0。所以先用正则把文本切成
 * 「连续中文」和「连续拉丁/数字」两类片段，只对中文片段过 jieba，英文片段整体当一个词。
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const segments = text.toLowerCase().match(/[一-龥]+|[a-z0-9]+/g) ?? [];
  for (const segment of segments) {
    if (/^[一-龥]+$/.test(segment)) {
      for (const token of nodejieba.cut(segment)) {
        const t = token.trim();
        if (t.length > 0 && !STOPWORDS.has(t)) {
          tokens.push(t);
        }
      }
    } else if (!STOPWORDS.has(segment)) {
      tokens.push(segment);
    }
  }
  return tokens;
}

/** 高频虚词：留着只会稀释 IDF（每个块里都有，等于谁都不匹配） */
const STOPWORDS = new Set([
  '的', '了', '是', '在', '和', '有', '就', '也', '都', '而', '及', '与', '着', '或', '一个',
  '我们', '你们', '他们', '这个', '那个', '什么', '怎么', '如何', '可以', '不是', '没有',
  'the', 'a', 'an', 'of', 'to', 'and', 'or', 'is', 'are', 'in', 'on', 'for', 'with',
]);