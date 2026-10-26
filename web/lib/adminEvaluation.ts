import { adminApi } from './adminApi';
import { apiErrorMessage } from './apiError';

/**
 * admin 评测 API 客户端 —— 对应 src/gateway/admin/evaluation-routes.ts
 * UI 详见 docs/04-c-ui-后台管理页面.md §5.6
 */

export interface EvaluationDatasetItem {
  id: string;
  question: string;
  reference_answer: string | null;
  scenario: string | null;
  difficulty: string | null;
}

export interface EvaluationDataset {
  id: string;
  name: string;
  version: string;
  description: string | null;
  item_count: number;
  created_at: string;
  updated_at: string;
  /** 已经跑过几次 */
  run_count: number;
  /** 最近一次跑批的总分（null = 没跑过） */
  latest_score: number | null;
}

export interface EvaluationScores {
  accuracy: number;
  completeness: number;
  style: number;
  safety: number;
}

export interface EvaluationRun {
  id: string;
  dataset_id: string;
  dataset_name: string | null;
  prompt_version: string | null;
  /** 触发方式：manual=手动跑的 / prompt_regression=提示词发布自动回归 */
  trigger: 'manual' | 'prompt_regression';
  /** 本次只跑了前 N 题（null = 跑全集） */
  item_limit: number | null;
  model: string | null;
  provider: string | null;
  status: 'running' | 'completed' | 'failed';
  total_items: number;
  completed_items: number;
  accuracy: number | null;
  completeness: number | null;
  style: number | null;
  safety: number | null;
  total_score: number | null;
  total_tokens: number;
  total_cost: number;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface EvaluationResult {
  id: string;
  item_id: string | null;
  question: string;
  answer: string;
  reference_answer: string | null;
  scores: EvaluationScores;
  judge_reason: string | null;
  latency_ms: number | null;
}

export interface Pagination {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
}

export async function fetchDatasets(): Promise<EvaluationDataset[]> {
  const { data } = await adminApi.get<{ datasets: EvaluationDataset[] }>('/evaluation/datasets');
  return data.datasets;
}

export async function fetchDataset(id: string): Promise<{
  dataset: EvaluationDataset;
  items: EvaluationDatasetItem[];
}> {
  const { data } = await adminApi.get<{
    dataset: EvaluationDataset;
    items: EvaluationDatasetItem[];
  }>(`/evaluation/datasets/${encodeURIComponent(id)}`);
  return data;
}

/** 新建评测集：给结构化题目数组，或给 JSONL 原文 */
export async function createDataset(payload: {
  name: string;
  version?: string | undefined;
  description?: string | null | undefined;
  items?: Array<{
    question: string;
    reference_answer?: string | null | undefined;
    scenario?: string | null | undefined;
    difficulty?: string | null | undefined;
  }> | undefined;
  jsonl?: string | undefined;
}): Promise<{ id: string; name: string; version: string; item_count: number; skipped: Array<{ line: number; message: string }> }> {
  const { data } = await adminApi.post<{
    id: string;
    name: string;
    version: string;
    item_count: number;
    skipped: Array<{ line: number; message: string }>;
  }>('/evaluation/datasets', payload);
  return data;
}

export async function deleteDataset(id: string): Promise<void> {
  await adminApi.delete(`/evaluation/datasets/${encodeURIComponent(id)}`);
}

export async function fetchRuns(params: {
  page?: number;
  page_size?: number;
  dataset_id?: string;
}): Promise<{ runs: EvaluationRun[]; pagination: Pagination }> {
  const { data } = await adminApi.get<{ runs: EvaluationRun[]; pagination: Pagination }>(
    '/evaluation/runs',
    { params },
  );
  return data;
}

export async function fetchRunDetail(
  id: string,
  params: { page?: number; page_size?: number } = {},
): Promise<{
  run: EvaluationRun;
  results: EvaluationResult[];
  pagination: Pagination;
  /** 程序侧指标（docs/08-评测方案.md §8.2） */
  stats: { p95_latency_ms: number; max_cost: number; avg_cost: number };
}> {
  const { data } = await adminApi.get<{
    run: EvaluationRun;
    results: EvaluationResult[];
    pagination: Pagination;
    stats: { p95_latency_ms: number; max_cost: number; avg_cost: number };
  }>(`/evaluation/runs/${encodeURIComponent(id)}`, { params });
  return data;
}

/**
 * 触发跑批 —— 后台异步跑，接口立刻返回 run（status='running'）
 *
 * @param promptVersion 指定用哪个提示词版本跑（A/B 对比的前提）
 *   - `undefined` = 不传这个字段 → 跟随租户当前生效的提示词
 *   - `null`      = 显式用内置默认提示词
 *   - 具体版本号  = 用那个版本（不存在 → 后端 400）
 */
export async function startRun(
  datasetId: string,
  promptVersion?: string | null,
): Promise<{
  id: string;
  status: string;
  total_items: number;
  completed_items: number;
  started_at: string;
}> {
  const payload: { dataset_id: string; prompt_version?: string | null } = {
    dataset_id: datasetId,
  };
  // ⚠️ undefined 和 null 语义不同 —— 不传 = 跟随生效版本，显式 null = 内置默认
  if (promptVersion !== undefined) {
    payload.prompt_version = promptVersion;
  }
  const { data } = await adminApi.post<{
    id: string;
    status: string;
    total_items: number;
    completed_items: number;
    started_at: string;
  }>('/evaluation/runs', payload);
  return data;
}

// ===== A/B 对比 =====

export interface RunComparisonDimension {
  key: 'accuracy' | 'completeness' | 'style' | 'safety' | 'total_score';
  label: string;
  a: number | null;
  b: number | null;
  /** b - a；任一边没分数时是 null */
  delta: number | null;
}

export type ComparisonVerdict = 'better' | 'worse' | 'same' | 'only_a' | 'only_b';

export interface RunComparisonItem {
  key: string;
  question: string;
  a: { scores: EvaluationScores; judge_reason: string | null; answer: string } | null;
  b: { scores: EvaluationScores; judge_reason: string | null; answer: string } | null;
  delta: number | null;
  verdict: ComparisonVerdict;
}

export interface RunComparison {
  a: EvaluationRun;
  b: EvaluationRun;
  /** 对比前要提醒用户的事 —— 不是错误，是「这个对比要这么读」 */
  warnings: string[];
  dimensions: RunComparisonDimension[];
  metrics: {
    total_tokens: { a: number; b: number; delta: number };
    total_cost: { a: number; b: number; delta: number };
    items: { a: number; b: number; matched: number };
  };
  item_stats: { better: number; worse: number; same: number; only_a: number; only_b: number };
  items: RunComparisonItem[];
}

/** 对比两次跑批 —— 换提示词版本的效果对比 */
export async function fetchRunComparison(runIdA: string, runIdB: string): Promise<RunComparison> {
  const { data } = await adminApi.get<RunComparison>('/evaluation/compare', {
    params: { run_id_a: runIdA, run_id_b: runIdB },
  });
  return data;
}

/**
 * 从 axios 错误里取出后端返回的可读消息。
 */
export function evaluationErrorMessage(err: unknown, fallback: string): string {
  return apiErrorMessage(err, fallback);
}
