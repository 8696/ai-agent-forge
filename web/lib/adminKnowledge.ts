import { adminApi } from './adminApi';

/**
 * admin 知识库 API 客户端 —— 对应 src/gateway/admin/knowledge-routes.ts
 * UI 详见 docs/04-c-ui-后台管理页面.md §5.2 / §5.3
 */

export type DocumentStatus = 'uploaded' | 'indexing' | 'ready' | 'failed';
export type DocumentFileType = 'pdf' | 'word' | 'markdown' | 'txt';

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
 * 从 axios 错误里取出后端返回的可读消息。
 * 后端错误体是 { code, message, details }（src/gateway/error-handler.ts）。
 */
export function errorMessage(err: unknown, fallback: string): string {
  const e = err as {
    response?: { status?: number; data?: { message?: string } };
    message?: string;
  };
  const status = e.response?.status;
  const serverMessage = e.response?.data?.message;
  if (status !== undefined && serverMessage !== undefined) {
    return serverMessage;
  }
  if (status !== undefined) {
    return `${fallback}（HTTP ${status}）`;
  }
  return e.message ?? fallback;
}