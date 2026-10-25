import { adminApi } from './adminApi';
import { apiErrorMessage } from './apiError';

/**
 * 租户工具调用记录 —— B3 工具调用（docs/12-b-需求-ai对话能力.md §B3）
 *
 * 对应 src/gateway/admin/tool-log-routes.ts（路由前缀 /api/v1/admin/tool-logs）。
 *
 * **一行 = 一次工具调用**，带请求参数（模型给的入参）和响应参数（工具的返回值）——
 * 用来回答「AI 到底调没调这个工具、调了什么、返回了什么」。
 */

export type ToolCallStatus = 'ok' | 'error' | 'timeout' | 'awaiting_confirmation';

export interface ToolCallLogItem {
  id: string;
  /** SDK 分配的调用 id */
  tool_call_id: string;
  /** 注册名（模型调用的就是这个名字） */
  tool_name: string;
  /** 内置实现 key */
  builtin: string | null;
  status: ToolCallStatus;
  /** 请求参数（模型给的入参） */
  args: unknown;
  /** 响应参数（工具的返回值） */
  output: unknown;
  /** 失败原因 */
  error: string | null;
  /** 耗时（毫秒） */
  duration_ms: number;
  session_id: string | null;
  user_id: string | null;
  message_id: string | null;
  trace_id: string | null;
  /** 调用时间（ISO8601） */
  created_at: string;
}

export interface ToolCallLogQuery {
  page?: number;
  page_size?: number;
  /** 按工具名精确筛 */
  tool_name?: string | undefined;
  /** 按状态精确筛 */
  status?: ToolCallStatus | undefined;
  /** 按会话筛 */
  session_id?: string | undefined;
  /** 起始时间（ISO8601） */
  from?: string | undefined;
  /** 结束时间（ISO8601） */
  to?: string | undefined;
  /** 模糊搜：入参 / 返回值里包含这个串 */
  keyword?: string | undefined;
}

export interface ToolCallLogListResponse {
  logs: ToolCallLogItem[];
  pagination: { page: number; page_size: number; total: number; total_pages: number };
}

export async function fetchToolCallLogs(
  query: ToolCallLogQuery,
): Promise<ToolCallLogListResponse> {
  const { data } = await adminApi.get<ToolCallLogListResponse>('/tool-logs', {
    params: {
      page: query.page ?? 1,
      page_size: query.page_size ?? 20,
      tool_name: query.tool_name,
      status: query.status,
      session_id: query.session_id,
      from: query.from,
      to: query.to,
      keyword: query.keyword,
    },
  });
  return data;
}

/** 本租户调用过的工具名（筛选下拉框用） */
export async function fetchToolCallNames(): Promise<string[]> {
  const { data } = await adminApi.get<{ names: string[] }>('/tool-logs/names');
  return data.names;
}

/** 把后端的错误信息挖出来给人看 */
export function toolLogErrorMessage(err: unknown, fallback: string): string {
  return apiErrorMessage(err, fallback);
}
