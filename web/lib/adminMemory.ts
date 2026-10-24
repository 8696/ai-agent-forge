import { adminApi } from './adminApi';
import type {
  AdminMemoryItem,
  MemoryCategory,
  MemoryOwner,
  MemoryPagination,
  MemorySource,
  MemoryStatus,
} from '@shared/types/memory';

/**
 * 租户后台 · 用户记忆 API —— B4（docs/12-b-需求-ai对话能力.md §B4）
 *
 * 对应后端 src/gateway/admin/memory-routes.ts
 */

/** 列表筛选 */
export interface MemoryListParams {
  page?: number;
  page_size?: number;
  user_id?: string;
  category?: MemoryCategory;
  source?: MemorySource;
  status?: MemoryStatus | 'all';
  keyword?: string;
}

/** 列本租户全部用户的记忆 */
export async function fetchMemories(params: MemoryListParams): Promise<{
  memories: AdminMemoryItem[];
  pagination: MemoryPagination;
}> {
  const { data } = await adminApi.get<{
    memories: AdminMemoryItem[];
    pagination: MemoryPagination;
  }>('/memories', { params });
  return data;
}

/** 哪些用户有记忆、各有多少条 */
export async function fetchMemoryOwners(): Promise<{ owners: MemoryOwner[] }> {
  const { data } = await adminApi.get<{ owners: MemoryOwner[] }>('/memories/owners');
  return data;
}

/** 管理员给某个用户加一条记忆（source='admin'） */
export async function createMemory(params: {
  user_id: string;
  content: string;
  category: MemoryCategory;
}): Promise<{ id: string; content: string; category: MemoryCategory; source: string }> {
  const { data } = await adminApi.post<{
    id: string;
    content: string;
    category: MemoryCategory;
    source: string;
  }>('/memories', params);
  return data;
}

/** 管理员改一条记忆的内容 / 分类 */
export async function updateMemory(
  id: string,
  patch: { content?: string; category?: MemoryCategory },
): Promise<{ id: string; content: string; category: MemoryCategory }> {
  const { data } = await adminApi.patch<{ id: string; content: string; category: MemoryCategory }>(
    `/memories/${encodeURIComponent(id)}`,
    patch,
  );
  return data;
}

/** 归档（软删） */
export async function archiveMemory(id: string): Promise<void> {
  await adminApi.delete(`/memories/${encodeURIComponent(id)}`);
}

/** 恢复归档的 */
export async function restoreMemory(id: string): Promise<{ id: string; status: string }> {
  const { data } = await adminApi.post<{ id: string; status: string }>(
    `/memories/${encodeURIComponent(id)}/restore`,
  );
  return data;
}

/** 物理删除（合规清理用，不可恢复） */
export async function deleteMemoryForever(id: string): Promise<void> {
  await adminApi.delete(`/memories/${encodeURIComponent(id)}/permanent`);
}

/**
 * 从 axios 错误里取出后端返回的可读消息。
 * 与 adminKnowledge.ts / customerChat.ts 的同名函数同构（后端错误体 { code, message, details }）。
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
