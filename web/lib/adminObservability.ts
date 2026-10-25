import { adminApi } from './adminApi';
import { apiErrorMessage } from './apiError';

/**
 * admin 观测 API 客户端 —— 对应 src/gateway/admin/observability-routes.ts
 * UI 详见 docs/04-c-ui-后台管理页面.md §5.7
 */

export type TraceStatus = 'success' | 'error';
export type CostRange = 'day' | 'week' | 'month' | 'custom';
export type CostGroupBy = 'model' | 'user' | 'channel' | 'provider';

export interface TraceItem {
  id: string;
  tenant_id: string;
  user_id: string | null;
  session_id: string | null;
  name: string;
  kind: string;
  status: TraceStatus;
  channel: string | null;
  provider: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost: number;
  duration_ms: number | null;
  error_message: string | null;
  started_at: string;
  ended_at: string | null;
}

export interface TraceSpan {
  id: string;
  trace_id: string;
  parent_span_id: string | null;
  name: string;
  kind: string;
  status: TraceStatus;
  duration_ms: number | null;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error_message: string | null;
  started_at: string;
  ended_at: string | null;
}

export interface TraceDetail {
  trace: TraceItem & { metadata: Record<string, unknown> | null };
  spans: TraceSpan[];
}

export interface TraceListParams {
  page?: number;
  page_size?: number;
  status?: TraceStatus | undefined;
  user_id?: string | undefined;
  session_id?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

export interface Pagination {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
}

export async function fetchTraces(
  params: TraceListParams,
): Promise<{ traces: TraceItem[]; pagination: Pagination }> {
  const { data } = await adminApi.get<{ traces: TraceItem[]; pagination: Pagination }>(
    '/observability/traces',
    { params },
  );
  return data;
}

export async function fetchTraceDetail(id: string): Promise<TraceDetail> {
  const { data } = await adminApi.get<TraceDetail>(`/observability/traces/${encodeURIComponent(id)}`);
  return data;
}

export interface CostBucket {
  key: string;
  label: string;
  calls: number;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cost: number;
}

export interface CostAnalysis {
  range: { from: string; to: string; range: CostRange };
  totals: {
    calls: number;
    total_tokens: number;
    input_tokens: number;
    output_tokens: number;
    cost: number;
  };
  series: CostBucket[];
  breakdown: CostBucket[];
  group_by: CostGroupBy;
}

export async function fetchCostAnalysis(params: {
  range?: CostRange | undefined;
  group_by?: CostGroupBy | undefined;
  from?: string | undefined;
  to?: string | undefined;
}): Promise<CostAnalysis> {
  const { data } = await adminApi.get<CostAnalysis>('/observability/cost', { params });
  return data;
}

export interface ObservabilitySummary {
  today: {
    conversations: number;
    p95_latency_ms: number;
    avg_latency_ms: number;
    cost: number;
    total_tokens: number;
    error_rate: number;
    errors: number;
    /** 今天最贵的一次对话花了多少（告警阈值 $0.5） */
    max_conversation_cost: number;
  };
  trend: Array<{ date: string; conversations: number; cost: number; errors: number }>;
}

export async function fetchSummary(): Promise<ObservabilitySummary> {
  const { data } = await adminApi.get<ObservabilitySummary>('/observability/summary');
  return data;
}

/**
 * 从 axios 错误里取出后端返回的可读消息。
 * 与 adminKnowledge.ts / adminConfig.ts 的同名函数同构。
 */
export function observabilityErrorMessage(err: unknown, fallback: string): string {
  return apiErrorMessage(err, fallback);
}
