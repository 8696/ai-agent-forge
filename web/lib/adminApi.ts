import { createApi } from './apiFactory';

/**
 * admin 子系统专属 axios 实例：baseURL 指向 /api/v1/admin
 * 详见 docs/03-技术栈与规范.md §B.5
 */
export const adminApi = createApi('/api/v1/admin');

// ============================================================
// 审计日志（D5 的读侧）
// ============================================================

/**
 * 审计日志的一行 —— 对应 src/gateway/admin/audit-routes.ts 的 GET /audit
 *
 * ⚠️ 后端只返回**本租户**的日志（tenant_id 强制过滤）：
 * 系统级日志（tenant_id 为 NULL —— 平台方改租户启停那类）租户 admin 看不到。
 */
export interface AuditItem {
  id: string;
  tenant_id: string;
  /** 操作者 id；用户被删了也还会有值 */
  user_id: string | null;
  /** 操作者邮箱；查不到（用户已删）时为 null */
  user_email: string | null;
  /** 操作类型，如 TENANT_MODEL_CREATE / USER_MEMORY_ARCHIVED */
  action: string;
  /** 资源类型，如 tenant_model / user_memory / document */
  resource_type: string | null;
  /** 资源 id */
  resource_id: string | null;
  /** 操作详情（改了什么前后值等） */
  details: unknown;
  /** 客户端 IP */
  ip: string | null;
  /** ISO 8601 */
  created_at: string;
}

export interface AuditPagination {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
}

export interface AuditListParams {
  page?: number;
  page_size?: number;
  user_id?: string | undefined;
  action?: string | undefined;
  resource_type?: string | undefined;
  /** ISO 8601 */
  from?: string | undefined;
  /** ISO 8601 */
  to?: string | undefined;
}

/** 列审计日志 */
export async function fetchAuditLogs(params: AuditListParams): Promise<{
  logs: AuditItem[];
  pagination: AuditPagination;
}> {
  const { data } = await adminApi.get<{ logs: AuditItem[]; pagination: AuditPagination }>(
    '/audit',
    {
      params,
    },
  );
  return data;
}

/**
 * 本租户日志里出现过的操作类型 —— 给「操作类型」筛选下拉框用
 *
 * 用后端给的真实清单而不是前端硬编码：action 是自由字符串，
 * 硬编码一份迟早漏掉新加的操作类型。
 */
export async function fetchAuditActions(): Promise<string[]> {
  const { data } = await adminApi.get<{ actions: string[] }>('/audit/actions');
  return data.actions;
}
