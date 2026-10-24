import { adminApi } from './adminApi';

/**
 * admin 租户级配置客户端 —— 对应 src/gateway/admin/config-routes.ts
 * UI 详见 docs/04-c-ui-后台管理页面.md §5.4 / §5.9
 *
 * 按形态分三块，各自独立页面：
 *   models     模型列表（一条 = 一套完整连接配置，可建多条、选一条启用）
 *   prompts    提示词版本（草稿 / 发布 / 回滚）
 *   settings   通用配置 KV（零散参数，形状是 key → value）
 *
 * ⚠️ **API Key 是只写字段**：类型里出现它的地方都标了「仅提交用」。
 * 后端读接口永不返回密钥本体，只给 has_api_key + api_key_hint。
 */

// ============================================================
// 模型
// ============================================================

export interface ProcessLlmDefaults {
  provider: string;
  llmModel: string;
  baseUrlConfigured: boolean;
}

/**
 * 模型条目的用途 —— 决定这条模型服务于哪条链路
 *
 *  - `chat`   对话模型
 *  - `memory` 记忆抽取模型（没配时抽取回落到对话模型）
 *  - `summary` 会话摘要模型（没配时摘要回落到对话模型）
 */
export type ModelUsageScope = 'chat' | 'memory' | 'summary';

export const MODEL_USAGE_SCOPE_LABEL: Record<ModelUsageScope, string> = {
  chat: '对话',
  memory: '记忆抽取',
  summary: '会话摘要',
};

export interface TenantModelItem {
  id: string;
  name: string;
  provider: string | null;
  model_id: string;
  base_url: string;
  has_api_key: boolean;
  api_key_hint: string | null;
  temperature: number | null;
  max_output_tokens: number | null;
  prompt_cache_enabled: boolean;
  is_active: boolean;
  /** 用途：chat=对话模型 / memory=记忆抽取模型 / summary=会话摘要模型 */
  usage_scope: ModelUsageScope;
  updated_at: string;
}

export interface SaveModelInput {
  name: string;
  provider?: string | null;
  model_id: string;
  base_url: string;
  /** 仅提交用：不带 = 编辑时保持原样 */
  api_key?: string;
  temperature?: number | null;
  max_output_tokens?: number | null;
  prompt_cache_enabled?: boolean;
  /** 用途；不带 = chat */
  usage_scope?: ModelUsageScope;
}

export interface ModelTestResult {
  ok: boolean;
  took_ms: number;
  provider?: string;
  model?: string;
  output?: string;
  error?: string;
}

export async function fetchModels(): Promise<{
  models: TenantModelItem[];
  process_defaults: ProcessLlmDefaults;
  secret_encryption_enabled: boolean;
  notes: string[];
  /** 当前生效的对话模型（null = 走平台默认） */
  active_chat: TenantModelItem | null;
  /** 当前生效的记忆抽取模型（null = 抽取回落到对话模型） */
  active_memory: TenantModelItem | null;
  /** 当前生效的会话摘要模型（null = 摘要回落到对话模型） */
  active_summary: TenantModelItem | null;
}> {
  const { data } = await adminApi.get<{
    models: TenantModelItem[];
    process_defaults: ProcessLlmDefaults;
    secret_encryption_enabled: boolean;
    notes: string[];
    active_chat: TenantModelItem | null;
    active_memory: TenantModelItem | null;
    active_summary: TenantModelItem | null;
  }>('/config/models');
  return data;
}

export async function createModel(payload: SaveModelInput): Promise<TenantModelItem> {
  const { data } = await adminApi.post<TenantModelItem>('/config/models', payload);
  return data;
}

export async function updateModel(id: string, payload: SaveModelInput): Promise<TenantModelItem> {
  const { data } = await adminApi.put<TenantModelItem>(`/config/models/${id}`, payload);
  return data;
}

export async function activateModel(id: string): Promise<TenantModelItem> {
  const { data } = await adminApi.post<TenantModelItem>(`/config/models/${id}/activate`, {});
  return data;
}

export async function deleteModel(id: string): Promise<void> {
  await adminApi.delete(`/config/models/${id}`);
}

export async function testModel(id: string): Promise<ModelTestResult> {
  const { data } = await adminApi.post<ModelTestResult>(
    `/config/models/${id}/test`,
    {},
    { timeout: 60_000 },
  );
  return data;
}

export async function checkEndpoint(baseUrl: string): Promise<{ ok: boolean; reason?: string }> {
  const { data } = await adminApi.post<{ ok: boolean; reason?: string }>(
    '/config/models/check-endpoint',
    { base_url: baseUrl },
    { timeout: 15_000 },
  );
  return data;
}

// ============================================================
// 通用配置（KV）
// ============================================================

export type SettingType = 'number' | 'boolean' | 'string';

export interface SettingItem {
  key: string;
  label: string;
  category: string;
  description: string;
  type: SettingType;
  min?: number;
  max?: number;
  /** 生效中的值（租户覆盖 or 平台默认） */
  value: number | boolean | string;
  /** 平台默认值 */
  fallback: number | boolean | string;
  /** 是否被租户显式覆盖过 */
  overridden: boolean;
  updated_at: string | null;
}

export async function fetchSettings(): Promise<{
  settings: SettingItem[];
  groups: string[];
  notes: string[];
}> {
  const { data } = await adminApi.get<{
    settings: SettingItem[];
    groups: string[];
    notes: string[];
  }>('/config/settings');
  return data;
}

/** 批量保存 `{ key: 值 }`；值为 null 表示清除覆盖、回落平台默认 */
export async function saveSettings(payload: Record<string, unknown>): Promise<SettingItem[]> {
  const { data } = await adminApi.put<{ settings: SettingItem[] }>('/config/settings', payload);
  return data.settings;
}

// ============================================================
// 告警（D3 / D4 / D5）
// ============================================================

export interface AdminAlert {
  id: string;
  level: 'error' | 'warning';
  title: string;
  detail: string;
  created_at: string | null;
}

export async function fetchAlerts(): Promise<AdminAlert[]> {
  const { data } = await adminApi.get<{ alerts: AdminAlert[] }>('/config/alerts');
  return data.alerts;
}

// ============================================================
// 提示词
// ============================================================

export type PromptStatus = 'draft' | 'production' | 'archived';

export interface PromptVersionItem {
  id: string;
  version: string;
  status: PromptStatus;
  description: string | null;
  deployed_at: string | null;
  updated_at: string;
  in_use: boolean;
}

export interface PromptVersionDetail {
  version: string;
  status: PromptStatus;
  content: string;
  description: string | null;
  updated_at: string;
}

export async function fetchPromptVersions(): Promise<PromptVersionItem[]> {
  const { data } = await adminApi.get<{ versions: PromptVersionItem[] }>('/config/prompts');
  return data.versions;
}

export async function fetchBuiltinPrompt(): Promise<{ content: string; version: string }> {
  const { data } = await adminApi.get<{ content: string; version: string }>(
    '/config/prompts/default',
  );
  return data;
}

/** 取单个版本的正文（列表接口不返回 content，避免一次拉几十 KB） */
export async function fetchPromptVersion(version: string): Promise<PromptVersionDetail> {
  const { data } = await adminApi.get<PromptVersionDetail>(
    `/config/prompts/${encodeURIComponent(version)}`,
  );
  return data;
}

export async function createPromptVersion(payload: {
  version: string;
  content: string;
  description?: string;
}): Promise<{ id: string; version: string; status: PromptStatus }> {
  const { data } = await adminApi.post<{ id: string; version: string; status: PromptStatus }>(
    '/config/prompts',
    payload,
  );
  return data;
}

export async function updatePromptDraft(
  version: string,
  payload: { content: string; description?: string },
): Promise<{ id: string; version: string; status: PromptStatus }> {
  const { data } = await adminApi.put<{ id: string; version: string; status: PromptStatus }>(
    `/config/prompts/${encodeURIComponent(version)}`,
    payload,
  );
  return data;
}

export async function publishPromptVersion(
  version: string,
): Promise<{ version: string; status: PromptStatus; deployed_at: string | null }> {
  const { data } = await adminApi.post<{
    version: string;
    status: PromptStatus;
    deployed_at: string | null;
  }>(`/config/prompts/${encodeURIComponent(version)}/publish`, {});
  return data;
}

export async function rollbackPromptVersion(version: string): Promise<{ version: string }> {
  const { data } = await adminApi.post<{ version: string }>(
    `/config/prompts/${encodeURIComponent(version)}/rollback`,
    {},
  );
  return data;
}

export async function deletePromptVersion(version: string): Promise<void> {
  await adminApi.delete(`/config/prompts/${encodeURIComponent(version)}`);
}

// ============================================================

/**
 * 从 axios 错误里取出后端返回的可读消息。
 * 与 adminKnowledge.ts 的同名函数同构（后端错误体 { code, message, details }）。
 */
export function configErrorMessage(err: unknown, fallback: string): string {
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
