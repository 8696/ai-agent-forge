import { createApi } from './apiFactory';

/**
 * system 子系统专属 axios 实例：baseURL 指向 /api/v1/system
 * 详见 docs/03-b-技术栈-后端栈.md §B.5
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
    /**
     * 启用中 = status='active' 且**没到期**（跟租户列表的「启用中」筛选同一口径）
     */
    active: number;
    /** 已禁用 = status='disabled' */
    disabled: number;
    /**
     * 已到期 = expires_at <= now（**不论启停**）
     *
     * ⚠️ 跟 active / disabled **有重叠** —— 一个「已禁用且已到期」的租户
     *    同时计入 disabled 和 expired。所以这三个数**相加不等于** total，
     *    `expired_total` 才是「全部已到期（含已禁用的）」。
     */
    expired: number;
    /** 全部已到期租户数（含已禁用的） */
    expired_total?: number;
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

// ============================================================
// 审计日志（平台方视角 · 跨租户）
// ============================================================

/**
 * 审计日志的一行 —— 对应 GET /api/v1/system/audit
 *
 * ⚠️ **跟租户后台的 AuditItem 有两处不同**：
 *   1. `tenant_id` 可能是 **null** —— 系统级日志（平台方改租户启停 / 到期时间那类）
 *      本来就没有租户归属
 *   2. 列表是**跨租户**的（平台方特权视角）
 */
export interface SystemAuditItem {
  id: string;
  /** 所属租户；null = 系统级日志 */
  tenant_id: string | null;
  user_id: string | null;
  user_email: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  details: unknown;
  ip: string | null;
  created_at: string;
}

export interface SystemAuditPagination {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
}

export interface SystemAuditListParams {
  page?: number;
  page_size?: number;
  /** 按租户过滤（不传 = 全部租户 + 系统级） */
  tenant_id?: string | undefined;
  user_id?: string | undefined;
  action?: string | undefined;
  resource_type?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

/** 列全部审计日志（跨租户） */
export async function fetchSystemAuditLogs(params: SystemAuditListParams): Promise<{
  logs: SystemAuditItem[];
  pagination: SystemAuditPagination;
}> {
  const { data } = await systemApi.get<{
    logs: SystemAuditItem[];
    pagination: SystemAuditPagination;
  }>('/audit', { params });
  return data;
}

/**
 * 全部日志里出现过的操作类型 —— 给「操作类型」筛选下拉框用
 *
 * 用后端给的真实清单而不是前端硬编码：action 是自由字符串，
 * 硬编码一份迟早漏掉新加的操作类型。
 */
export async function fetchSystemAuditActions(): Promise<string[]> {
  const { data } = await systemApi.get<{ actions: string[] }>('/audit/actions');
  return data.actions;
}
