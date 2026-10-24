import { adminApi } from './adminApi';

/**
 * 租户 API 密钥管理 —— E1（docs/12-e-需求-业务接入与平台运营.md §E1）
 *
 * 对应 src/gateway/public/api-key-admin-routes.ts（路由前缀 /api/v1/admin/api-keys）。
 * 端点在物理上放在 public/ 桶里，但 **URL 和鉴权都属于 admin 命名空间** ——
 * 这边是「登录后台来管钥匙」，跟「拿钥匙来调接口」那套鉴权完全无关。
 *
 * ⚠️ **完整 key 只在创建那一次返回**：服务端只留 bcrypt hash，之后谁也拿不回去。
 *    列表接口永远不返回 hash，也不返回完整 key（只有 key_prefix 前 8 位）。
 */
export interface ApiKeyItem {
  id: string;
  name: string;
  /** 前 8 位（`ak_` + 5 位随机）—— 用来肉眼辨认，不是完整 key */
  key_prefix: string;
  /** 最后一次被用来调接口的时间 */
  last_used_at: string | null;
  /** 到期时间；null = 永不过期 */
  expires_at: string | null;
  /** 撤销时间；null = 还没撤销 */
  revoked_at: string | null;
  created_at: string;
}

export interface CreatedApiKey {
  id: string;
  name: string;
  key_prefix: string;
  /** ⚠️ 完整 key —— 只在这一次响应里出现，界面上要提示用户立刻复制 */
  api_key: string;
  expires_at: string | null;
  created_at: string;
}

export async function fetchApiKeys(): Promise<ApiKeyItem[]> {
  const { data } = await adminApi.get<{ keys: ApiKeyItem[] }>('/api-keys');
  return data.keys;
}

export async function createApiKey(input: {
  name: string;
  expires_at?: string | undefined;
}): Promise<CreatedApiKey> {
  const { data } = await adminApi.post<CreatedApiKey>('/api-keys', input);
  return data;
}

export async function revokeApiKey(id: string): Promise<void> {
  await adminApi.delete(`/api-keys/${encodeURIComponent(id)}`);
}
