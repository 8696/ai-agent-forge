import { customerApi } from './customerApi';
import { apiErrorMessage } from './apiError';
import type { MemoryCategory, MemoryStatus, UserMemoryItem } from '@shared/types/memory';

/**
 * 前台 · 我的记忆 API —— B4（docs/12-b-需求-ai对话能力.md §B4）
 *
 * 对应后端 src/gateway/customer/memory-routes.ts
 */

/** 列我的记忆 */
export async function fetchMyMemories(params: {
  status?: MemoryStatus | 'all';
  category?: MemoryCategory;
  /** 只取最近 N 条（首页概览卡用；不传 = 全给） */
  limit?: number;
}): Promise<{ memories: UserMemoryItem[]; total: number; memory_enabled: boolean }> {
  const { data } = await customerApi.get<{
    memories: UserMemoryItem[];
    total: number;
    memory_enabled: boolean;
  }>('/memories', { params });
  return data;
}

/** 我自己新增一条 */
export async function createMyMemory(body: {
  content: string;
  category: MemoryCategory;
}): Promise<{ id: string; content: string; category: MemoryCategory; source: string }> {
  const { data } = await customerApi.post<{
    id: string;
    content: string;
    category: MemoryCategory;
    source: string;
  }>('/memories', body);
  return data;
}

/** 我编辑一条 */
export async function updateMyMemory(
  id: string,
  patch: { content?: string; category?: MemoryCategory },
): Promise<{ id: string; content: string; category: MemoryCategory }> {
  const { data } = await customerApi.patch<{ id: string; content: string; category: MemoryCategory }>(
    `/memories/${encodeURIComponent(id)}`,
    patch,
  );
  return data;
}

/** 我删一条（归档，可恢复） */
export async function deleteMyMemory(id: string): Promise<void> {
  await customerApi.delete(`/memories/${encodeURIComponent(id)}`);
}

/** 恢复归档的 */
export async function restoreMyMemory(id: string): Promise<{ id: string; status: string }> {
  const { data } = await customerApi.post<{ id: string; status: string }>(
    `/memories/${encodeURIComponent(id)}/restore`,
  );
  return data;
}

/** 我的记忆总开关 */
export async function fetchMyMemorySetting(): Promise<{ memory_enabled: boolean }> {
  const { data } = await customerApi.get<{ memory_enabled: boolean }>('/memories/settings');
  return data;
}

/** 改我的记忆总开关 */
export async function updateMyMemorySetting(enabled: boolean): Promise<{ memory_enabled: boolean }> {
  const { data } = await customerApi.put<{ memory_enabled: boolean }>('/memories/settings', {
    memory_enabled: enabled,
  });
  return data;
}

/** 清空我的全部记忆（归档，可恢复） */
export async function clearMyMemories(): Promise<void> {
  await customerApi.delete('/memories');
}

/**
 * 彻底删掉我的全部记忆（物理删，**不可恢复**）。
 *
 * 跟 clearMyMemories 的区别：那个是归档（软删），数据还在库里、还能恢复；
 * 这个是真删 —— 用户行使「删除我的全部个人数据」的权利时，要的是这个。
 */
export async function purgeMyMemories(): Promise<void> {
  await customerApi.delete('/memories/permanent');
}

/** 彻底删掉我的一条记忆（物理删，不可恢复） */
export async function purgeMyMemory(id: string): Promise<void> {
  await customerApi.delete(`/memories/${encodeURIComponent(id)}/permanent`);
}

/**
 * 从 axios 错误里取出该给用户看的话。
 *
 * ⚠️ **唯一实现在 `web/lib/apiError.ts`** —— 这里只是兼容别名。
 *    旧版各抄一份的实现把 403 → 「没有权限」、500 → 「服务异常，已记录」
 *    这两条规格文案丢了（详见 web/lib/apiError.ts 的说明）。
 */
export const errorMessage = apiErrorMessage;
