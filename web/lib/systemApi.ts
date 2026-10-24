import { createApi } from './apiFactory';

/**
 * system 子系统专属 axios 实例：baseURL 指向 /api/v1/system
 * 详见 docs/03-技术栈与规范.md §B.5
 */
export const systemApi = createApi('/api/v1/system');

/**
 * 平台方总览 —— 对应 GET /api/v1/system/stats
 * UI 详见 docs/04-d-ui-系统级与公共组件.md §6.2
 *
 * ⚠️ 跨租户口径：只有 system 角色能拿到。租户 admin 调这个端点会 401。
 */
export interface SystemStats {
  tenants: {
    total: number;
    active: number;
    disabled: number;
    /** 已过期的租户数 */
    expired: number;
    plans: Array<{ plan: string; count: number }>;
  };
  users: { tenant_users: number; system_users: number };
  today: {
    conversations: number;
    errors: number;
    error_rate: number;
    cost: number;
    total_tokens: number;
  };
  trend: Array<{ date: string; conversations: number; cost: number; errors: number }>;
  over_budget: Array<{
    tenant_id: string;
    code: string;
    name: string;
    used: number;
    limit: number;
  }>;
}

export async function fetchSystemStats(): Promise<SystemStats> {
  const { data } = await systemApi.get<SystemStats>('/stats');
  return data;
}
