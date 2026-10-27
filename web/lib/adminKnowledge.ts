import { adminApi } from './adminApi';
import { apiErrorMessage } from './apiError';

/**
 * admin 知识库 API 客户端 —— 对应 src/gateway/admin/knowledge-routes.ts
 * UI 详见 docs/04-c-ui-后台管理页面.md §5.2 / §5.3
 */

export type DocumentStatus = 'uploaded' | 'indexing' | 'ready' | 'failed';
export type DocumentFileType = 'pdf' | 'markdown' | 'txt';

export interface KnowledgeDocument {
  id: string;
  title: string;
  file_type: DocumentFileType | null;
  status: DocumentStatus;
  chunk_count: number;
  error_message: string | null;
  uploaded_at: string;
  updated_at: string;
}

export interface KnowledgePagination {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
}

export interface KnowledgeStats {
  /**
   * 本租户**全部**文档数 —— **不受 keyword / status 筛选影响**。
   *
   * ⚠️ 「文档总数」卡片必须用这个，不能用 `pagination.total`（那是筛选后的条数）。
   */
  total_documents: number;
  /** 本租户 ready 文档的块数合计 */
  chunk_total: number;
  /** BM25 内存索引里的块数 */
  bm25_chunk_total: number;
  /** Qdrant 全库点总数（跨租户，运维参考） */
  qdrant_points: number;
}

export interface UploadResult {
  id: string;
  title: string;
  file_type: DocumentFileType | null;
  status: 'ready' | 'failed';
  chunk_count: number;
  pages?: number;
  error?: string;
}

export interface SearchHit {
  doc_id: string;
  chunk_index: number;
  source: string;
  text: string;
  /** 相关度 [0,1]（重排生效时是重排分，否则是归一化 RRF 分） */
  score: number;
  /** 原始 RRF 分（0.016~0.033） */
  rrf_score: number;
  /** 重排原始分；null = 这一条没经过重排 */
  rerank_score: number | null;
  /** 命中来源：vector=语义 / bm25=关键词 */
  sources: Array<'vector' | 'bm25'>;
  vector_rank: number | null;
  bm25_rank: number | null;
}

export interface SearchResult {
  query: string;
  took_ms: number;
  /** 这次的排序是不是重排模型给的（false = 没配服务 / 租户关了 / 调用失败降级） */
  rerank_applied: boolean;
  hits: SearchHit[];
}

/** 一篇文档的切片（诊断 + 编辑视图用） */
export interface DocumentChunk {
  chunk_index: number;
  text: string;
  source: string;
  /**
   * 标题层级路径（如 `['产品手册', '退款政策']`）。
   * null = 改结构感知切块之前入库的老块，没有这个信息
   * （老文档重新索引之后才会有）。
   */
  heading_path: string[] | null;
  /** 该块是本节第几块（1 起）；老块没有 → null */
  section_chunk_index: number | null;
  /** 本节一共切成了几块；老块没有 → null */
  section_chunk_total: number | null;
  /** 有没有被人工改过（改过文字或改过结构） */
  edited: boolean;
  updated_at: number;
}

export interface DocumentChunksResult {
  document: {
    id: string;
    title: string;
    file_type: DocumentFileType | null;
    status: DocumentStatus;
    chunk_count: number;
    /** 这篇文档有没有人工编辑过的块（重新索引时会被保留） */
    has_manual_edits: boolean;
  };
  chunks: DocumentChunk[];
  pagination: KnowledgePagination;
}

/** 一次切片写操作的结果 */
export interface ChunkWriteResult {
  /** 改文字 / 还原时是这块的序号 */
  chunk_index?: number;
  /** 改完之后的总块数 */
  chunk_count: number;
  /** 这次真正重新算的向量数（改动的那几块） */
  embedded: number;
  /** 复用了旧向量的块数（省下的 embedding 调用） */
  reused: number;
}

/** 后端只放行这三种扩展名，前端上传前先拦一道，少一次往返 */
export const ACCEPTED_UPLOAD_EXTENSIONS = ['.pdf', '.md', '.markdown', '.txt'];

export const ACCEPTED_UPLOAD_ACCEPT_ATTR = ACCEPTED_UPLOAD_EXTENSIONS.join(',');

export async function fetchDocuments(params: {
  page?: number;
  page_size?: number;
  status?: DocumentStatus;
  keyword?: string;
}): Promise<{
  documents: KnowledgeDocument[];
  pagination: KnowledgePagination;
  stats: KnowledgeStats;
}> {
  const { data } = await adminApi.get<
    {
      documents: KnowledgeDocument[];
      pagination: KnowledgePagination;
      stats: KnowledgeStats;
    }
  >('/knowledge', { params });
  return data;
}

export async function uploadDocument(file: File): Promise<UploadResult> {
  const form = new FormData();
  form.append('file', file);
  const { data } = await adminApi.post<UploadResult>('/knowledge/upload', form, {
    // 不设 Content-Type：交给浏览器自己补 multipart boundary。
    // 手动写成 'multipart/form-data'（不带 boundary）后端解析必然失败。
    // 大 PDF 的解析 + Embedding 是同步跑的，10s 默认超时不够
    timeout: 300_000,
  });
  return data;
}

export async function reindexDocument(id: string): Promise<UploadResult> {
  const { data } = await adminApi.post<UploadResult>(`/knowledge/${id}/reindex`, null, {
    timeout: 300_000,
  });
  return data;
}

export async function deleteDocument(id: string): Promise<void> {
  await adminApi.delete(`/knowledge/${id}`);
}

export async function searchKnowledge(
  query: string,
  topK: number,
): Promise<SearchResult> {
  const { data } = await adminApi.post<SearchResult>(
    '/knowledge/search',
    { query, top_k: topK },
    { timeout: 60_000 },
  );
  return data;
}

/**
 * 拉一篇文档的切片（诊断视图）。
 *
 * 跨租户访问一律 404（后端先查 DB 归属，再按 tenant_id 过滤 Qdrant）。
 */
export async function fetchDocumentChunks(
  id: string,
  params?: { page?: number; page_size?: number },
): Promise<DocumentChunksResult> {
  const { data } = await adminApi.get<DocumentChunksResult>(`/knowledge/${id}/chunks`, {
    params,
  });
  return data;
}

// ===== 切片编辑（写操作） =====
//
// ⚠️ **编辑之后后端会重算被改动的那几块的向量** —— 一块文本 = 一个向量，
//    只改文字不改向量的话，检索按旧向量排序却返回新文字，模型会答错。
//    没改的块复用旧向量，所以改 1 块只多 1 次 embedding 调用。

/** 改一块的文字 */
export async function editChunk(
  id: string,
  index: number,
  text: string,
): Promise<ChunkWriteResult> {
  const { data } = await adminApi.patch<ChunkWriteResult>(
    `/knowledge/${id}/chunks/${index}`,
    { text },
    { timeout: 120_000 },
  );
  return data;
}

/**
 * 把一块拆成两块。
 *
 * @param at 拆分位置（相对**整块文本**的字符位置）
 */
export async function splitChunk(
  id: string,
  index: number,
  at: number,
): Promise<ChunkWriteResult> {
  const { data } = await adminApi.post<ChunkWriteResult>(
    `/knowledge/${id}/chunks/${index}/split`,
    { at },
    { timeout: 120_000 },
  );
  return data;
}

/** 把几块合并成一块（必须连续） */
export async function mergeChunks(
  id: string,
  indexes: number[],
): Promise<ChunkWriteResult> {
  const { data } = await adminApi.post<ChunkWriteResult>(
    `/knowledge/${id}/chunks/merge`,
    { indexes },
    { timeout: 120_000 },
  );
  return data;
}

/** 把一块还原成程序生成的文本（撤销人工改动） */
export async function resetChunk(
  id: string,
  index: number,
): Promise<ChunkWriteResult> {
  const { data } = await adminApi.post<ChunkWriteResult>(
    `/knowledge/${id}/chunks/${index}/reset`,
    null,
    { timeout: 120_000 },
  );
  return data;
}

/**
 * 从 axios 错误里取出后端返回的可读消息。
 *
 * ⚠️ **统一走 `apiErrorMessage`**（docs/04-d §8.4）——
 *    2026-10-27 之前这里自己抄了一份「只区分有没有服务器消息」的旧实现，
 *    结果 403 显示成英文 `'Forbidden'`、500 显示成「服务器内部错误」，
 *    而规格要求的是「没有权限」/「服务异常，已记录」。
 *
 * 这个别名保留下来只为兼容还没改 import 的调用方
 * （`web/pages/admin/KnowledgeSearchPage.tsx`）—— 它跟 `apiErrorMessage` 是同一个函数。
 *
 * @deprecated 新代码直接用 `apiErrorMessage`（`web/lib/apiError.ts`）
 */
export const errorMessage = apiErrorMessage;
