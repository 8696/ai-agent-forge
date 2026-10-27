import { adminApi } from './adminApi';
import { apiErrorMessage } from './apiError';
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
 *
 * ⚠️ **统一走 `apiErrorMessage`**（docs/04-d §8.4）——
 *    这里原来自己抄了一份旧实现，403 会显示成英文 `'Forbidden'`、
 *    500 显示成「服务器内部错误」，不是规格要求的「没有权限」/「服务异常，已记录」。
 *
 * 别名保留下来只为兼容还没改 import 的调用方
 * （`web/pages/admin/MemoriesPage.tsx`）—— 它跟 `apiErrorMessage` 是同一个函数。
 *
 * @deprecated 新代码直接用 `apiErrorMessage`（`web/lib/apiError.ts`）
 */
export const errorMessage = apiErrorMessage;
