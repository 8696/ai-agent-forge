import { adminApi } from './adminApi';

/**
 * admin 知识库 API 客户端（Step 4 · C1）
 * 详见 docs/16-c §C1 + docs/06 §6.3 + src/gateway/admin/knowledge-routes.ts
 *
 * 端点（baseURL=/api/v1/admin）：
 *   GET    /knowledge                       列本租户文档
 *   POST   /knowledge/upload                上传 + 同步索引（multipart/form-data, field=file）
 *   DELETE /knowledge/:id                   删除文档
 *   POST   /knowledge/test                  检索测试（top 5 命中）
 */

export type DocumentStatus = 'uploaded' | 'indexing' | 'ready' | 'failed';
export type FileType = 'pdf' | 'markdown' | 'txt';

export interface KnowledgeDocument {
  id: string;
  title: string;
  file_type: FileType | null;
  status: DocumentStatus;
  chunk_count: number;
  uploaded_at: string;
  updated_at: string;
}

export interface UploadResult {
  id: string;
  status: DocumentStatus;
  chunk_count: number;
  title: string;
  file_type: FileType;
}

export interface SearchHit {
  doc_id: string;
  chunk_index: number;
  source: string;
  score: number;
  text: string;
}

export async function listDocuments(): Promise<KnowledgeDocument[]> {
  const { data } = await adminApi.get<{ documents: KnowledgeDocument[] }>('/knowledge');
  return data.documents;
}

export async function uploadDocument(
  file: File,
  onProgress?: (pct: number) => void,
): Promise<UploadResult> {
  const form = new FormData();
  form.append('file', file);
  const { data } = await adminApi.post<UploadResult>('/knowledge/upload', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    onUploadProgress: (e) => {
      if (e.total !== undefined && e.total > 0 && onProgress !== undefined) {
        onProgress(Math.round((e.loaded * 100) / e.total));
      }
    },
  });
  return data;
}

export async function deleteDocument(id: string): Promise<void> {
  await adminApi.delete(`/knowledge/${id}`);
}

export async function searchKnowledge(params: {
  query: string;
  top_k?: number;
  score_threshold?: number;
}): Promise<{ query: string; hits: SearchHit[] }> {
  const { data } = await adminApi.post<{ query: string; hits: SearchHit[] }>(
    '/knowledge/test',
    params,
  );
  return data;
}