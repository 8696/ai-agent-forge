import { Op, col, fn } from 'sequelize';
import { generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import {
  EvaluationDataset,
  EvaluationItem,
  EvaluationResult,
  EvaluationRun,
  Tenant,
  type EvaluationRunTrigger,
  type EvaluationScores,
} from '../models';
import { logger } from '../logger';
import { withRetry } from '../lib/retry';
import { config } from '../config';
import { buildContextWindow } from './chat';
import { hybridSearch, type HybridHit } from '../rag/hybrid-search';
import { planRetrieval } from '../rag/retrieval-plan';
import { resolveLlmSettings, type ResolvedLlmSettings } from './llm-settings';
import { assertPromptVersionUsable, resolveTenantPrompt } from './prompt-registry';
import { recordLlmUsage } from './cost-tracking';
import { writeAuditLog } from '../lib/audit-log';
import { JUDGE_SYSTEM_PROMPT, renderJudgeInput } from '../prompts/evaluation';
import { NotFoundError, ValidationError } from '../lib/errors';

/**
 * 评测服务 —— D1（docs/12-d-需求-运维稳定.md §D1）
 *
 * 一句话：**用租户当前的提示词 + 知识库回答一组题，再让一个大模型当裁判打分。**
 *
 * ## 为什么评测要跑「真实的对话链路」
 * 验收里写的是「故意改坏提示词 → 分数下降」。这要求评测用的**就是线上那条链路**：
 * 同一套系统提示词、同一套检索、同一套模型。���能「另写一段代码模拟回答」——
 * 那样评出来的分数跟线上行为对不上，改坏提示词也不会掉分。
 * 所以这里复用 buildContextWindow + hybridSearch，跟 chat.ts 走的是同一套拼装逻辑。
 *
 * ## 为什么是「两条 LLM 调用 / 题」
 *   1. 生成：用租户提示词 + 知识库回答题目
 *   2. 裁判：让另一个调用把「题目 + 参考答案 + 回答」打分
 * 跑 50 题 = 100 次调用，所以：
 *   - 跑批是**后台异步**的，接口立刻返回 run id，页面轮询进度
 *   - 单次跑批的题数有上限（EVALUATION_MAX_ITEMS），别让一次误点烧掉半个月的额度
 *
 * ## 裁判为什么不是「结构化输出」
 * 智谱等 Anthropic 兼容网关对 tool-based schema 的支持参差不齐，
 * 统一走「文本输出 + 宽松解析」，比 generateObject 稳。
 * 解析器（parseJudgeScores）会把分数夹到 0~5，缺维度补默认值。
 */

// ============================================================
// 评测集文件解析（纯函数，单测直接喂字符串）
// ============================================================

export interface EvaluationItemInput {
  question: string;
  reference_answer: string | null;
  scenario: string | null;
  difficulty: string | null;
}

export interface ParsedEvaluationFile {
  items: EvaluationItemInput[];
  /** 出错的行（不影响其它行入库，前端会展示） */
  errors: Array<{ line: number; message: string }>;
}

const DIFFICULTIES = new Set(['easy', 'medium', 'hard']);

/**
 * 解析 JSONL 评测集。
 *
 * 每行一个 JSON 对象：`{question, reference_answer?, scenario?, difficulty?}`。
 *
 * 设计取舍：
 *  - **坏行不中断整份文件** —— 跳过 + 记进 errors。用户上传 200 条时，
 *    因为第 137 行少个逗号就整份传不上去是不能接受的
 *  - question 为空 / 非字符串 → 记为坏行
 *  - difficulty 认三个值（easy/medium/hard），别的原样存（不硬拦，
 *    评测集是租户自己的东西，字段多了不该挡着不让传）
 */
export function parseEvaluationJsonl(text: string): ParsedEvaluationFile {
  const items: EvaluationItemInput[] = [];
  const errors: Array<{ line: number; message: string }> = [];

  const lines = text.split(/\r?\n/);
  lines.forEach((raw, idx) => {
    const line = raw.trim();
    if (line === '') {
      return;
    }
    const lineNo = idx + 1;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      errors.push({ line: lineNo, message: '这一行不是合法 JSON' });
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      errors.push({ line: lineNo, message: '这一行不是一个 JSON 对象' });
      return;
    }

    const obj = parsed as Record<string, unknown>;
    const question = obj['question'];
    if (typeof question !== 'string' || question.trim() === '') {
      errors.push({ line: lineNo, message: '缺少 question（或不是非空字符串）' });
      return;
    }

    const reference = obj['reference_answer'];
    const scenario = obj['scenario'];
    const difficulty = obj['difficulty'];

    items.push({
      question: question.trim(),
      reference_answer:
        typeof reference === 'string' && reference.trim() !== '' ? reference.trim() : null,
      scenario: typeof scenario === 'string' && scenario.trim() !== '' ? scenario.trim() : null,
      difficulty:
        typeof difficulty === 'string' && difficulty.trim() !== ''
          ? difficulty.trim().toLowerCase()
          : null,
    });
  });

  return { items, errors };
}

/** 难度归一化：只认 easy/medium/hard，其它当 null（展示时显示「未标注」） */
export function normalizeDifficulty(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const v = value.trim().toLowerCase();
  return DIFFICULTIES.has(v) ? v : null;
}

// ============================================================
// 裁判输出解析（纯函数，单测直接喂字符串）
// ============================================================

export const JUDGE_DIMENSIONS = ['accuracy', 'completeness', 'style', 'safety'] as const;
export type JudgeDimension = (typeof JUDGE_DIMENSIONS)[number];

const DIMENSION_LABELS: Record<JudgeDimension, string> = {
  accuracy: '准确性',
  completeness: '完整性',
  style: '风格',
  safety: '安全性',
};

export function judgeDimensionLabel(dim: JudgeDimension): string {
  return DIMENSION_LABELS[dim];
}

/**
 * 从裁判的输出里抠出 JSON 并解析成四维分数。
 *
 * 裁判不一定会乖乖只输出 JSON（有的网关会包 ```json、有的会带一句解释）。
 * 这里按「宽松但有界」处理：
 *  1. 去掉 ``` 围栏
 *  2. 找第一个 `{` 到最后一个 `}` 之间的片段
 *  3. JSON.parse
 *  4. 每个维度：取数字、夹到 0~5、取整；缺了就用该维度的中位数 3 兜底
 *  5. reason 取字符串；不是字符串就置 null
 *
 * 全程解析不出来 → 返回 null（调用方按「裁判不可用」处理：这条不计分，
 * 但**不**把整批跑批判失败 —— 一条题裁判挂了不代表整批都不算数）。
 */
export function parseJudgeScores(raw: string): { scores: EvaluationScores; reason: string | null } | null {
  const text = raw.trim();
  if (text === '') {
    return null;
  }

  const withoutFence = text.replace(/```(?:json)?/gi, '').replace(/```/g, '');
  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  if (start === -1 || end <= start) {
    return null;
  }

  let obj: unknown;
  try {
    obj = JSON.parse(withoutFence.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return null;
  }

  const record = obj as Record<string, unknown>;
  const scores = {} as EvaluationScores;
  for (const dim of JUDGE_DIMENSIONS) {
    scores[dim] = clampScore(record[dim]);
  }

  const reasonRaw = record['reason'];
  const reason = typeof reasonRaw === 'string' && reasonRaw.trim() !== '' ? reasonRaw.trim() : null;

  return { scores, reason };
}

/**
 * 分数归一化到 0~5 的整数。
 *
 * ⚠️ **不能直接 `Number(value)`**：`Number(null)` 是 0、`Number('')` 也是 0 ——
 *    裁判漏写一个维度（null / 空串）会被当成「打了 0 分」，
 *    把整条拉低。缺失一律当 3（中位数）处理。
 */
function clampScore(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.max(0, Math.min(5, Math.round(value))) : 3;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') {
      return 3;
    }
    const n = Number(trimmed);
    return Number.isFinite(n) ? Math.max(0, Math.min(5, Math.round(n))) : 3;
  }
  // null / undefined / 布尔 / 对象 —— 都不是分数，当缺失处理
  return 3;
}

/** 四维平均（0~5） */
export function averageScore(scores: EvaluationScores): number {
  const sum = JUDGE_DIMENSIONS.reduce((acc, dim) => acc + scores[dim], 0);
  return Number((sum / JUDGE_DIMENSIONS.length).toFixed(3));
}

// ============================================================
// 评测集 CRUD
// ============================================================

export interface CreateDatasetInput {
  tenantId: string;
  userId: string | null;
  name: string;
  version?: string | undefined;
  description?: string | null | undefined;
  items: EvaluationItemInput[];
}

export async function createDataset(input: CreateDatasetInput): Promise<EvaluationDataset> {
  if (input.items.length === 0) {
    throw new ValidationError('评测集至少要有 1 条题目');
  }
  if (input.items.length > config.EVALUATION.MAX_ITEMS) {
    throw new ValidationError(
      `评测集最多 ${config.EVALUATION.MAX_ITEMS} 条，当前 ${input.items.length} 条`,
    );
  }

  const dataset = await EvaluationDataset.create({
    tenant_id: input.tenantId,
    name: input.name,
    version: input.version ?? 'v1',
    description: input.description ?? null,
    item_count: input.items.length,
    created_by: input.userId,
  });

  await EvaluationItem.bulkCreate(
    input.items.map((item) => ({
      dataset_id: dataset.id,
      tenant_id: input.tenantId,
      question: item.question,
      reference_answer: item.reference_answer,
      scenario: item.scenario,
      difficulty: normalizeDifficulty(item.difficulty),
    })),
  );

  return dataset;
}

export interface DatasetListRow {
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

export async function listDatasets(tenantId: string): Promise<DatasetListRow[]> {
  const datasets = await EvaluationDataset.findAll({
    where: { tenant_id: tenantId },
    order: [['created_at', 'DESC']],
  });

  const runs = await EvaluationRun.findAll({
    where: { tenant_id: tenantId, status: 'completed' },
    attributes: ['dataset_id', 'total_score'],
    order: [['created_at', 'DESC']],
  });

  const latestByDataset = new Map<string, number | null>();
  const countByDataset = new Map<string, number>();
  for (const run of runs) {
    countByDataset.set(run.dataset_id, (countByDataset.get(run.dataset_id) ?? 0) + 1);
    if (!latestByDataset.has(run.dataset_id)) {
      latestByDataset.set(run.dataset_id, run.total_score);
    }
  }

  return datasets.map((d) => ({
    id: d.id,
    name: d.name,
    version: d.version,
    description: d.description,
    item_count: d.item_count,
    created_at: d.created_at.toISOString(),
    updated_at: d.updated_at.toISOString(),
    run_count: countByDataset.get(d.id) ?? 0,
    latest_score: latestByDataset.get(d.id) ?? null,
  }));
}

export interface DatasetDetail {
  dataset: DatasetListRow;
  items: Array<{
    id: string;
    question: string;
    reference_answer: string | null;
    scenario: string | null;
    difficulty: string | null;
  }>;
}

export async function getDataset(
  tenantId: string,
  datasetId: string,
  itemLimit = 50,
): Promise<DatasetDetail | null> {
  const dataset = await EvaluationDataset.findOne({
    where: { id: datasetId, tenant_id: tenantId },
  });
  if (dataset === null) {
    return null;
  }

  const items = await EvaluationItem.findAll({
    where: { dataset_id: datasetId, tenant_id: tenantId },
    order: [['created_at', 'ASC']],
    limit: itemLimit,
  });

  const runs = await EvaluationRun.findAll({
    where: { tenant_id: tenantId, dataset_id: datasetId, status: 'completed' },
    attributes: ['total_score'],
    order: [['created_at', 'DESC']],
  });

  return {
    dataset: {
      id: dataset.id,
      name: dataset.name,
      version: dataset.version,
      description: dataset.description,
      item_count: dataset.item_count,
      created_at: dataset.created_at.toISOString(),
      updated_at: dataset.updated_at.toISOString(),
      run_count: runs.length,
      latest_score: runs[0]?.total_score ?? null,
    },
    items: items.map((i) => ({
      id: i.id,
      question: i.question,
      reference_answer: i.reference_answer,
      scenario: i.scenario,
      difficulty: i.difficulty,
    })),
  };
}

export async function deleteDataset(tenantId: string, datasetId: string): Promise<boolean> {
  const dataset = await EvaluationDataset.findOne({
    where: { id: datasetId, tenant_id: tenantId },
  });
  if (dataset === null) {
    return false;
  }
  // 先删题目和跑批（results 跟着 run 删），再删评测集本身
  const runs = await EvaluationRun.findAll({
    where: { dataset_id: datasetId, tenant_id: tenantId },
    attributes: ['id'],
  });
  if (runs.length > 0) {
    await EvaluationResult.destroy({
      where: { run_id: { [Op.in]: runs.map((r) => r.id) }, tenant_id: tenantId },
    });
  }
  await EvaluationRun.destroy({ where: { dataset_id: datasetId, tenant_id: tenantId } });
  await EvaluationItem.destroy({ where: { dataset_id: datasetId, tenant_id: tenantId } });
  await dataset.destroy();
  return true;
}

// ============================================================
// 跑批
// ============================================================

export interface RunListRow {
  id: string;
  dataset_id: string;
  dataset_name: string | null;
  prompt_version: string | null;
  /** 触发方式：manual=手动 / prompt_regression=提示词发布自动回归 */
  trigger: EvaluationRunTrigger;
  /** 本次只跑了前 N 题（null = 跑全集） */
  item_limit: number | null;
  model: string | null;
  provider: string | null;
  status: string;
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

function toRunRow(run: EvaluationRun): RunListRow {
  return {
    id: run.id,
    dataset_id: run.dataset_id,
    dataset_name: run.dataset_name,
    prompt_version: run.prompt_version,
    trigger: run.run_trigger,
    item_limit: run.item_limit,
    model: run.model,
    provider: run.provider,
    status: run.status,
    total_items: run.total_items,
    completed_items: run.completed_items,
    accuracy: run.accuracy,
    completeness: run.completeness,
    style: run.style,
    safety: run.safety,
    total_score: run.total_score,
    total_tokens: run.total_tokens,
    total_cost: Number(run.total_cost),
    error_message: run.error_message,
    started_at: run.started_at.toISOString(),
    finished_at: run.finished_at === null ? null : run.finished_at.toISOString(),
  };
}

export async function listRuns(
  tenantId: string,
  page: number,
  pageSize: number,
  datasetId?: string,
): Promise<{ runs: RunListRow[]; pagination: { page: number; page_size: number; total: number; total_pages: number } }> {
  const where: Record<string, unknown> = { tenant_id: tenantId };
  if (datasetId !== undefined && datasetId !== '') {
    where['dataset_id'] = datasetId;
  }
  const { rows, count } = await EvaluationRun.findAndCountAll({
    where,
    order: [['created_at', 'DESC']],
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });
  return {
    runs: rows.map(toRunRow),
    pagination: {
      page,
      page_size: pageSize,
      total: count,
      total_pages: Math.ceil(count / pageSize),
    },
  };
}

export async function getRun(tenantId: string, runId: string): Promise<RunListRow | null> {
  const run = await EvaluationRun.findOne({ where: { id: runId, tenant_id: tenantId } });
  return run === null ? null : toRunRow(run);
}

export interface RunResultRow {
  id: string;
  item_id: string | null;
  question: string;
  answer: string;
  reference_answer: string | null;
  scores: EvaluationScores;
  judge_reason: string | null;
  latency_ms: number | null;
}

export async function listRunResults(
  tenantId: string,
  runId: string,
  page: number,
  pageSize: number,
): Promise<{
  results: RunResultRow[];
  pagination: { page: number; page_size: number; total: number; total_pages: number };
  /** 程序侧指标（docs/08-评测方案.md §8.2「延迟 / 成本 程序测」） */
  stats: { p95_latency_ms: number; max_cost: number; avg_cost: number };
}> {
  const { rows, count } = await EvaluationResult.findAndCountAll({
    where: { run_id: runId, tenant_id: tenantId },
    order: [['created_at', 'ASC']],
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  // p95 / 成本要按**全部**明细算，不能只用当前页 —— 用聚合查询而不是把明细拉出来算
  const agg = (await EvaluationResult.findOne({
    where: { run_id: runId, tenant_id: tenantId },
    attributes: [
      [fn('MAX', col('cost')), 'max_cost'],
      [fn('AVG', col('cost')), 'avg_cost'],
    ],
    raw: true,
  })) as unknown as { max_cost?: number | null; avg_cost?: number | null } | null;

  const latencies = await EvaluationResult.findAll({
    where: { run_id: runId, tenant_id: tenantId },
    attributes: ['latency_ms'],
    raw: true,
  });
  const durations = latencies
    .map((r) => Number((r as { latency_ms?: number | null }).latency_ms ?? 0))
    .filter((d) => d > 0)
    .sort((a, b) => a - b);
  const p95 =
    durations.length === 0
      ? 0
      : durations[Math.min(durations.length - 1, Math.ceil(durations.length * 0.95) - 1)] ?? 0;

  return {
    results: rows.map((r) => ({
      id: r.id,
      item_id: r.item_id,
      question: r.question,
      answer: r.answer,
      reference_answer: r.reference_answer,
      scores: r.scores,
      judge_reason: r.judge_reason,
      latency_ms: r.latency_ms,
    })),
    pagination: {
      page,
      page_size: pageSize,
      total: count,
      total_pages: Math.ceil(count / pageSize),
    },
    stats: {
      p95_latency_ms: p95,
      max_cost: Number(toFinite(agg?.max_cost)),
      avg_cost: Number(toFinite(agg?.avg_cost)),
    },
  };
}

function toFinite(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 触发一次跑批。
 *
 * 接口立刻返回 run（status='running'），实际工作在后台跑。
 * 为什么不在请求里同步跑完：50 题 = 100 次 LLM 调用，几十秒到几分钟，
 * HTTP 请求撑不住（nginx 默认 60s 就断了），而且进度也没法看。
 *
 * @param options.limit 只跑前 N 题（小规模回归用；不传 = 跑全集）
 * @param options.trigger 触发方式（`manual` / `prompt_regression`）
 * @param options.promptVersion **指定用哪个提示词版本跑这一批**（A/B 对比的前提）
 */
export async function startEvaluationRun(
  tenantId: string,
  userId: string | null,
  datasetId: string,
  options?: {
    limit?: number | undefined;
    trigger?: EvaluationRunTrigger | undefined;
    /**
     * 指定用哪个提示词版本跑 —— A/B 对比的前提（docs/12-e 裁定表 表 4）。
     *
     * - `undefined`（不传）= 跟随租户**当前生效**的提示词（原有行为）
     * - `null` / `''`     = 显式用**内置默认**提示词
     * - 具体版本号        = 用那个版本；**不存在直接 400**（不回落）
     *
     * ⚠️ 「不存在就报错」是刻意的：用户点了「用 v2 跑」，
     *    跑批却悄悄用了默认提示词，那对比出来的报告会骗人。
     */
    promptVersion?: string | null | undefined;
  },
): Promise<EvaluationRun> {
  const dataset = await EvaluationDataset.findOne({
    where: { id: datasetId, tenant_id: tenantId },
  });
  if (dataset === null) {
    throw new ValidationError('评测集不存在');
  }
  if (!config.EVALUATION.ENABLED) {
    throw new ValidationError('评测功能未开启');
  }

  // 指定了版本就先校验它存在 —— 要**同步 400**，
  // 不能等到后台跑批时才失败（那时用户已经拿到 202 了）
  if (options?.promptVersion !== undefined) {
    await assertPromptVersionUsable(tenantId, options.promptVersion);
  }

  // 小规模回归：只跑前 N 题
  const limit = options?.limit;
  const totalItems = limit === undefined ? dataset.item_count : Math.min(limit, dataset.item_count);

  const run = await EvaluationRun.create({
    tenant_id: tenantId,
    dataset_id: datasetId,
    dataset_name: dataset.name,
    status: 'running',
    total_items: totalItems,
    completed_items: 0,
    run_trigger: options?.trigger ?? 'manual',
    item_limit: limit ?? null,
    // 先记下「请求用哪个版本」，跑完后 executeRun 会写成**实际生效**的版本
    prompt_version: options?.promptVersion || null,
    started_at: new Date(),
  });

  // 后台跑，不 await —— 错误在 executeRun 内部兜住并写进 run 行
  void executeRun(run.id, tenantId, datasetId, limit, options?.promptVersion);

  return run;
}

/**
 * 跑批的主循环 —— 每条题：生成 → 裁判 → 落明细
 *
 * @param itemLimit 只跑前 N 题（不传 = 跑全集）
 * @param promptVersion 指定用哪个提示词版本（不传 = 跟随租户当前生效的）
 */
async function executeRun(
  runId: string,
  tenantId: string,
  datasetId: string,
  itemLimit?: number | undefined,
  promptVersion?: string | null | undefined,
): Promise<void> {
  let totalTokens = 0;
  let totalCost = 0;

  try {
    const llm = await resolveLlmSettings(tenantId);
    if (llm.apiKey.trim() === '' || llm.baseUrl.trim() === '' || llm.model.trim() === '') {
      throw new Error('未配置 LLM 凭据，无法跑评测');
    }

    const tenant = await Tenant.findByPk(tenantId);
    const tenantName = tenant?.name ?? '本公司';
    // 指定了版本就用指定的；没指定才跟随租户当前生效的那个
    const effectivePromptVersion =
      promptVersion === undefined ? llm.promptVersion : promptVersion;
    const resolvedPrompt = await resolveTenantPrompt(
      tenantId,
      effectivePromptVersion,
      tenantName,
    );

    await EvaluationRun.update(
      {
        model: llm.model,
        provider: llm.provider,
        prompt_version: resolvedPrompt.version,
      },
      { where: { id: runId } },
    );

    const allItems = await EvaluationItem.findAll({
      where: { dataset_id: datasetId, tenant_id: tenantId },
      order: [['created_at', 'ASC']],
    });
    // 小规模回归只跑前 N 题（一次题 = 2 次 LLM 调用，跑全集太贵）
    const items =
      itemLimit === undefined ? allItems : allItems.slice(0, itemLimit);

    const scored: EvaluationScores[] = [];

    for (const item of items) {
      const startedAt = Date.now();
      try {
        const generated = await generateAnswer({
          tenantId,
          tenantName,
          llm,
          promptContent: resolvedPrompt.origin === 'tenant' ? resolvedPrompt.text : null,
          question: item.question,
        });
        totalTokens += generated.usage.input_tokens + generated.usage.output_tokens;
        totalCost += generated.cost;

        const judged = await judgeAnswer({
          tenantId,
          llm,
          question: item.question,
          referenceAnswer: item.reference_answer,
          answer: generated.answer,
        });
        totalTokens += judged.usage.input_tokens + judged.usage.output_tokens;
        totalCost += judged.cost;

        if (judged.scores !== null) {
          scored.push(judged.scores);
          await EvaluationResult.create({
            run_id: runId,
            tenant_id: tenantId,
            item_id: item.id,
            question: item.question,
            answer: generated.answer,
            reference_answer: item.reference_answer,
            scores: judged.scores,
            judge_reason: judged.reason,
            input_tokens: generated.usage.input_tokens + judged.usage.input_tokens,
            output_tokens: generated.usage.output_tokens + judged.usage.output_tokens,
            cost: generated.cost + judged.cost,
            latency_ms: Date.now() - startedAt,
          });
        }
      } catch (err: unknown) {
        // 一条题失败不该中断整批 —— 记录后继续下一条
        logger.error(
          { err: err instanceof Error ? err.message : String(err), runId, itemId: item.id },
          '评测单条失败，跳过',
        );
      }

      await EvaluationRun.update(
        { completed_items: scored.length, total_tokens: totalTokens, total_cost: totalCost },
        { where: { id: runId } },
      );
    }

    if (scored.length === 0) {
      throw new Error('所有题目都没能完成评分（模型或裁判不可用）');
    }

    const averages = averageByDimension(scored);
    await EvaluationRun.update(
      {
        status: 'completed',
        completed_items: scored.length,
        accuracy: averages.accuracy,
        completeness: averages.completeness,
        style: averages.style,
        safety: averages.safety,
        total_score: averageScore({
          accuracy: averages.accuracy,
          completeness: averages.completeness,
          style: averages.style,
          safety: averages.safety,
        }),
        total_tokens: totalTokens,
        total_cost: totalCost,
        finished_at: new Date(),
      },
      { where: { id: runId } },
    );

    await checkScoreDrop(tenantId, datasetId, runId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message, runId }, '评测跑批失败');
    await EvaluationRun.update(
      {
        status: 'failed',
        error_message: message.slice(0, 500),
        total_tokens: totalTokens,
        total_cost: totalCost,
        finished_at: new Date(),
      },
      { where: { id: runId } },
    );
  }
}

function averageByDimension(scores: EvaluationScores[]): EvaluationScores {
  const out = {} as EvaluationScores;
  for (const dim of JUDGE_DIMENSIONS) {
    const sum = scores.reduce((acc, s) => acc + s[dim], 0);
    out[dim] = Number((sum / scores.length).toFixed(3));
  }
  return out;
}

/** 单条题的生成结果 + 用量 */
interface GeneratedAnswer {
  answer: string;
  usage: { input_tokens: number; output_tokens: number };
  cost: number;
}

/**
 * 评测的检索 —— **跟线上对话同一套口径**
 *
 * 单独抽出来是为了两件事：
 *  1. `generateAnswer` 只管「拼上下文 + 调模型」，检索这段单独看
 *  2. **可单测** —— 断言它真的把租户的两个开关（查询改写 / 重排）传下去了
 *
 * ⚠️ **2026-10-26 修的一处口径偏差**：
 * 以前这里直接调 `hybridSearch({query, tenantId, topK})`，既不传 `rerankEnabled`，
 * 也没有查询改写步骤。租户一旦改了这两个开关，**评测跑的检索就不是线上那一套了**
 * （docs/12-d §D1 的验收明写「同一套系统提示词 + 同一套检索 + 同一套模型」）。
 * 现在跟线上一起走 `planRetrieval()`，口径由结构保证一致。
 */
export async function retrieveForEvaluation(input: {
  tenantId: string;
  question: string;
  llm: ResolvedLlmSettings;
}): Promise<{
  hits: HybridHit[];
  /** 检索整体失败时的降级文案；null = 检索成功（哪怕一条都没命中） */
  retrievalError: string | null;
  /** 实际用于检索的查询（改写后；没改写就是原问题）—— 落库用，方便排查 */
  effectiveQuery: string;
}> {
  const { llm } = input;

  // 改写 + 重排开关 —— 跟线上（chat.ts）共用同一个 plan 函数
  const plan = await planRetrieval({
    query: input.question,
    queryRewriteEnabled: llm.queryRewriteEnabled,
    rerankEnabled: llm.rerankEnabled,
    apiKey: llm.apiKey,
    baseUrl: llm.baseUrl,
    model: llm.model,
  });

  try {
    const hits = await hybridSearch({
      query: plan.query,
      tenantId: input.tenantId,
      topK: llm.retrievalTopK,
      // 租户可以在后台关掉自己的重排（docs/12-c §C4）—— 线上也是这样传的
      rerankEnabled: plan.rerankEnabled,
    });
    return { hits, retrievalError: null, effectiveQuery: plan.query };
  } catch (err: unknown) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), tenantId: input.tenantId },
      '评测时检索失败，降级为无资料回答',
    );
    return {
      hits: [],
      retrievalError: '知识库检索暂时不可用，本次回答没有使用参考资料。',
      effectiveQuery: plan.query,
    };
  }
}

/**
 * 用租户当前的提示词 + 知识库回答一道题。
 *
 * 走的是**和线上一模一样的拼装逻辑**（buildContextWindow + 同一套检索），
 * 所以「改坏提示词 → 分数下降」这条验收才成立。
 */
async function generateAnswer(input: {
  tenantId: string;
  tenantName: string;
  llm: Awaited<ReturnType<typeof resolveLlmSettings>>;
  promptContent: string | null;
  question: string;
}): Promise<GeneratedAnswer> {
  const { llm } = input;

  const { hits: rawHits, retrievalError } = await retrieveForEvaluation({
    tenantId: input.tenantId,
    question: input.question,
    llm,
  });

  const window = buildContextWindow({
    tenantName: input.tenantName,
    promptContent: input.promptContent,
    retrievalTopK: llm.retrievalTopK,
    maxHistoryTurns: llm.maxHistoryTurns,
    retrievalTokenBudget: llm.retrievalTokenBudget,
    contextTokenBudget: llm.contextTokenBudget,
    // 评测是单轮问答：没有历史
    historyRows: [],
    rawHits,
    retrievalError,
  });

  const anthropic = createAnthropic({ apiKey: llm.apiKey, baseURL: llm.baseUrl });
  // ⚠️ maxRetries: 0 —— 重试统一由 withRetry 负责（带抖动，见 src/lib/retry.ts）
  const result = await withRetry(
    () =>
      generateText({
        model: anthropic(llm.model),
        // 系统提示词必须走 system 参数（塞进 messages 的 system 角色会被智谱 400）
        system: window.systemText,
        messages: [{ role: 'user', content: input.question }],
        temperature: llm.temperature,
        maxOutputTokens: llm.maxOutputTokens,
        maxRetries: 0,
      }),
    {
        onRetry: (attempt: number, delayMs: number, err: unknown) => {
          logger.warn(
            { attempt, delayMs, err: err instanceof Error ? err.message : String(err) },
            'LLM 调用失败，准备重试',
          );
        },
      },
  );

  const usage = {
    input_tokens: result.usage.inputTokens ?? 0,
    output_tokens: result.usage.outputTokens ?? 0,
  };
  const cost = await recordLlmUsage({
    tenantId: input.tenantId,
    userId: null,
    sessionId: null,
    messageId: null,
    provider: llm.provider,
    model: llm.model,
    usage: {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    },
  });

  return { answer: result.text, usage, cost };
}

/** 裁判结果 */
interface JudgedAnswer {
  scores: EvaluationScores | null;
  reason: string | null;
  usage: { input_tokens: number; output_tokens: number };
  cost: number;
}

/** 让大模型当裁判打四维分 */
async function judgeAnswer(input: {
  tenantId: string;
  llm: Awaited<ReturnType<typeof resolveLlmSettings>>;
  question: string;
  referenceAnswer: string | null;
  answer: string;
}): Promise<JudgedAnswer> {
  const { llm } = input;
  const anthropic = createAnthropic({ apiKey: llm.apiKey, baseURL: llm.baseUrl });

  const result = await withRetry(
    () =>
      generateText({
        model: anthropic(llm.model),
        system: JUDGE_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: renderJudgeInput({
              question: input.question,
              referenceAnswer: input.referenceAnswer,
              answer: input.answer,
            }),
          },
        ],
        // 裁判要稳定：温度 0
        temperature: 0,
        maxOutputTokens: 800,
        maxRetries: 0,
      }),
    {
        onRetry: (attempt: number, delayMs: number, err: unknown) => {
          logger.warn(
            { attempt, delayMs, err: err instanceof Error ? err.message : String(err) },
            'LLM 调用失败，准备重试',
          );
        },
      },
  );

  const usage = {
    input_tokens: result.usage.inputTokens ?? 0,
    output_tokens: result.usage.outputTokens ?? 0,
  };
  const cost = await recordLlmUsage({
    tenantId: input.tenantId,
    userId: null,
    sessionId: null,
    messageId: null,
    provider: llm.provider,
    model: llm.model,
    usage: {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    },
  });

  const parsed = parseJudgeScores(result.text);
  return {
    scores: parsed?.scores ?? null,
    reason: parsed?.reason ?? null,
    usage,
    cost,
  };
}

// ============================================================
// 分数下跌告警
// ============================================================

/** 分数跌幅达到这个比例就告警（10%） */
export const SCORE_DROP_THRESHOLD = 0.1;

/**
 * 跑批完成后跟**上一次**跑批比，分数跌了 ≥10% 就写一条审计告警。
 *
 * 只跟同一个评测集的上一次比：换了评测集分数没有可比性。
 * 告警走 audit_logs（动作 EVALUATION_SCORE_DROPPED），
 * 后台顶栏的告警条会把它显示出来（见 src/services/alerts.ts）。
 */
export async function checkScoreDrop(
  tenantId: string,
  datasetId: string,
  runId: string,
): Promise<void> {
  const current = await EvaluationRun.findOne({ where: { id: runId, tenant_id: tenantId } });
  if (current === null || current.status !== 'completed' || current.total_score === null) {
    return;
  }

  const previous = await EvaluationRun.findOne({
    where: {
      tenant_id: tenantId,
      dataset_id: datasetId,
      status: 'completed',
      id: { [Op.ne]: runId },
    },
    order: [['created_at', 'DESC']],
  });
  if (previous === null || previous.total_score === null || previous.total_score <= 0) {
    return;
  }

  const dropRatio = (previous.total_score - current.total_score) / previous.total_score;
  if (dropRatio < SCORE_DROP_THRESHOLD) {
    return;
  }

  logger.warn(
    {
      tenantId,
      datasetId,
      runId,
      previous: previous.total_score,
      current: current.total_score,
      dropRatio: Number(dropRatio.toFixed(4)),
    },
    '评测分数较上次下跌超过阈值',
  );

  await writeAuditLog({
    tenant_id: tenantId,
    user_id: null,
    action: 'EVALUATION_SCORE_DROPPED',
    resource_type: 'evaluation_run',
    resource_id: runId,
    details: {
      dataset_id: datasetId,
      dataset_name: current.dataset_name,
      previous_score: previous.total_score,
      current_score: current.total_score,
      drop_ratio: Number(dropRatio.toFixed(4)),
      threshold: SCORE_DROP_THRESHOLD,
    },
  });
}

// ============================================================
// A/B 对比 —— 两个跑批放在一起看
// ============================================================

/**
 * 逐题对比最多拉多少条明细。
 *
 * 一次跑批最多 `EVALUATION_MAX_ITEMS` 题，两次就是两倍。
 * 这个上限是**保护** —— 免得拿两个超大评测集把响应撑爆。
 * 超出会在 warnings 里说明「明细被截断」。
 */
export const COMPARISON_ITEM_LIMIT = 2000;

/** 对比页带的回答长度上限 —— 完整回答在「跑批详情」抽屉里看 */
const COMPARISON_ANSWER_LIMIT = 1500;

/** 对比结果里的一条明细（跑批明细的精简版） */
export interface ComparisonResultRow {
  item_id: string | null;
  question: string;
  answer: string;
  scores: EvaluationScores;
  judge_reason: string | null;
}

/**
 * 逐题对比的结论：
 * - `better` / `worse` —— B 比 A 好 / 差（按四维平均的总分）
 * - `same` —— 基本持平
 * - `only_a` / `only_b` —— 只有一次跑批里有这道题
 */
export type ComparisonVerdict = 'better' | 'worse' | 'same' | 'only_a' | 'only_b';

export interface RunComparisonItem {
  /** 匹配键（item_id 或题目文本）—— 前端做 React key 用 */
  key: string;
  question: string;
  a: { scores: EvaluationScores; judge_reason: string | null; answer: string } | null;
  b: { scores: EvaluationScores; judge_reason: string | null; answer: string } | null;
  /** b - a（按四维平均的总分）；只有一边有结果时是 null */
  delta: number | null;
  verdict: ComparisonVerdict;
}

export interface RunComparisonDimension {
  key: 'accuracy' | 'completeness' | 'style' | 'safety' | 'total_score';
  label: string;
  a: number | null;
  b: number | null;
  /** b - a；任一边没分数时是 null */
  delta: number | null;
}

export interface RunComparison {
  a: RunListRow;
  b: RunListRow;
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

/** 逐题对比的「持平」阈值 —— 0.01 分以内算持平（裁判打的是整数分，平均后噪声很小） */
const COMPARISON_SAME_THRESHOLD = 0.01;

/** 把库里的分数补齐成四维（缺哪维按 3 算，跟裁判的默认一致） */
function normalizeScores(raw: unknown): EvaluationScores {
  const s = (raw ?? {}) as Partial<Record<JudgeDimension, number>>;
  const num = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : 3;
  return {
    accuracy: num(s.accuracy),
    completeness: num(s.completeness),
    style: num(s.style),
    safety: num(s.safety),
  };
}

interface ComparisonBucket {
  rows: ComparisonResultRow[];
  cursor: number;
}

/** 按某个键把 B 侧的明细分桶 —— 同键多行时靠 cursor 一对一消费 */
function buildBucket(
  rows: ComparisonResultRow[],
  keyOf: (row: ComparisonResultRow) => string | null,
): Map<string, ComparisonBucket> {
  const map = new Map<string, ComparisonBucket>();
  for (const row of rows) {
    const key = keyOf(row);
    if (key === null || key === '') continue;
    let bucket = map.get(key);
    if (bucket === undefined) {
      bucket = { rows: [], cursor: 0 };
      map.set(key, bucket);
    }
    bucket.rows.push(row);
  }
  return map;
}

/** 从桶里取一条还没被用过的（`used` 保证同一条明细不会被两个键各领一次） */
function takeFromBucket(
  map: Map<string, ComparisonBucket>,
  key: string | null,
  used: Set<ComparisonResultRow>,
): ComparisonResultRow | null {
  if (key === null || key === '') return null;
  const bucket = map.get(key);
  if (bucket === undefined) return null;
  while (bucket.cursor < bucket.rows.length) {
    const row = bucket.rows[bucket.cursor] as ComparisonResultRow;
    bucket.cursor += 1;
    if (used.has(row)) continue;
    used.add(row);
    return row;
  }
  return null;
}

/**
 * 生成一个**在本次对比里唯一**的匹配键。
 *
 * ⚠️ 题目文本可能重复（同一道题在评测集里出现两次），
 *    而 `item_id` 为 null 时只能拿题目文本当键 —— 不去重的话前端 Table 的 key 会撞。
 */
function uniqueKey(seen: Set<string>, base: string): string {
  let key = base;
  let n = 1;
  while (seen.has(key)) {
    key = `${base}#${n}`;
    n += 1;
  }
  seen.add(key);
  return key;
}

/**
 * 把两次跑批的明细**一对一**配对 —— 纯函数，单测直接喂两组行。
 *
 * 配对顺序：
 *   1. 同一个评测集 → 按 `item_id` 配（精确，同一道题在两次跑批里的行 id 相同）
 *   2. 配不上 → 按**题目文本**配（兜底：换了评测集 / item_id 缺失时也能配上）
 *
 * ⚠️ 一对一：B 侧每条明细最多被领走一次 —— 同一道题出现两次时不会两边都配上。
 */
export function matchComparisonItems(
  rowsA: ComparisonResultRow[],
  rowsB: ComparisonResultRow[],
  sameDataset: boolean,
): RunComparisonItem[] {
  const bByItemId = buildBucket(rowsB, (r) => (sameDataset ? r.item_id : null));
  const bByQuestion = buildBucket(rowsB, (r) => r.question.trim());
  const used = new Set<ComparisonResultRow>();

  const items: RunComparisonItem[] = [];
  const seenKeys = new Set<string>();

  for (const a of rowsA) {
    let b: ComparisonResultRow | null = null;
    if (sameDataset && a.item_id !== null) {
      b = takeFromBucket(bByItemId, a.item_id, used);
    }
    if (b === null) {
      b = takeFromBucket(bByQuestion, a.question.trim(), used);
    }

    const scoreA = normalizeScores(a.scores);
    const sideB =
      b === null
        ? null
        : { scores: normalizeScores(b.scores), judge_reason: b.judge_reason, answer: b.answer };
    const scoreB = sideB === null ? null : sideB.scores;
    const delta =
      scoreB === null ? null : Number((averageScore(scoreB) - averageScore(scoreA)).toFixed(3));

    items.push({
      key: uniqueKey(seenKeys, a.item_id ?? `q:${a.question.slice(0, 40)}`),
      question: a.question,
      a: { scores: scoreA, judge_reason: a.judge_reason, answer: a.answer },
      b: sideB,
      delta,
      verdict: verdictOf(delta, b === null),
    });
  }

  // B 侧剩下的 = 只有 B 有这道题
  for (const b of rowsB) {
    if (used.has(b)) continue;
    const scoreB = normalizeScores(b.scores);
    items.push({
      key: uniqueKey(seenKeys, `only_b:${b.item_id ?? b.question.slice(0, 40)}`),
      question: b.question,
      a: null,
      b: { scores: scoreB, judge_reason: b.judge_reason, answer: b.answer },
      delta: null,
      verdict: 'only_b',
    });
  }

  return items;
}

function verdictOf(delta: number | null, missingB: boolean): ComparisonVerdict {
  if (delta === null) return missingB ? 'only_a' : 'same';
  if (delta > COMPARISON_SAME_THRESHOLD) return 'better';
  if (delta < -COMPARISON_SAME_THRESHOLD) return 'worse';
  return 'same';
}

async function loadComparisonResults(
  tenantId: string,
  runId: string,
): Promise<ComparisonResultRow[]> {
  const rows = await EvaluationResult.findAll({
    where: { run_id: runId, tenant_id: tenantId },
    order: [['created_at', 'ASC']],
    limit: COMPARISON_ITEM_LIMIT,
    attributes: ['item_id', 'question', 'answer', 'scores', 'judge_reason'],
  });
  return rows.map((r) => ({
    item_id: r.item_id,
    question: r.question,
    answer:
      r.answer.length > COMPARISON_ANSWER_LIMIT
        ? `${r.answer.slice(0, COMPARISON_ANSWER_LIMIT)}…`
        : r.answer,
    scores: normalizeScores(r.scores),
    judge_reason: r.judge_reason,
  }));
}

const COMPARISON_DIMENSION_LABELS: Record<RunComparisonDimension['key'], string> = {
  accuracy: '准确性',
  completeness: '完整性',
  style: '风格',
  safety: '安全性',
  total_score: '总分',
};

/**
 * 对比两次跑批 —— A/B 对比的后端（docs/12-e 裁定表 表 4）。
 *
 * 返回**汇总 + 逐题**两层：
 *   - 汇总：四维 + 总分的 A / B / 差值，外加 token / 成本 / 题数
 *   - 逐题：每道题两边各打了多少分、差多少、谁更好
 *
 * ⚠️ **跨租户**：两次 run 都按 tenant_id 查 —— 别的租户的 run id 一律 404。
 */
export async function compareRuns(
  tenantId: string,
  runIdA: string,
  runIdB: string,
): Promise<RunComparison> {
  const [a, b] = await Promise.all([getRun(tenantId, runIdA), getRun(tenantId, runIdB)]);
  if (a === null) {
    throw new NotFoundError('评测跑批');
  }
  if (b === null) {
    throw new NotFoundError('评测跑批');
  }

  const warnings: string[] = [];
  if (a.status !== 'completed' || b.status !== 'completed') {
    warnings.push('有跑批还没跑完，分数可能还会变 —— 建议等两次都完成后再对比');
  }
  const sameDataset = a.dataset_id === b.dataset_id;
  if (!sameDataset) {
    warnings.push('两次跑批不是同一个评测集，逐题只能按题目文本配对');
  }
  if (a.prompt_version === b.prompt_version) {
    warnings.push('两次跑批用的是同一个提示词版本 —— 分数差异不来自提示词');
  }
  if (a.model !== b.model) {
    warnings.push('两次跑批用的模型不同 —— 分数差异可能来自模型而不是提示词');
  }

  const [rowsA, rowsB] = await Promise.all([
    loadComparisonResults(tenantId, runIdA),
    loadComparisonResults(tenantId, runIdB),
  ]);
  if (rowsA.length >= COMPARISON_ITEM_LIMIT || rowsB.length >= COMPARISON_ITEM_LIMIT) {
    warnings.push(`明细超过 ${COMPARISON_ITEM_LIMIT} 条，逐题明细已被截断`);
  }

  const items = matchComparisonItems(rowsA, rowsB, sameDataset);

  const item_stats = { better: 0, worse: 0, same: 0, only_a: 0, only_b: 0 };
  for (const item of items) {
    if (item.verdict === 'better') item_stats.better += 1;
    else if (item.verdict === 'worse') item_stats.worse += 1;
    else if (item.verdict === 'same') item_stats.same += 1;
    else if (item.verdict === 'only_a') item_stats.only_a += 1;
    else item_stats.only_b += 1;
  }
  const matched = item_stats.better + item_stats.worse + item_stats.same;

  const dimensions: RunComparisonDimension[] = (
    ['accuracy', 'completeness', 'style', 'safety', 'total_score'] as const
  ).map((key) => {
    const va = a[key];
    const vb = b[key];
    return {
      key,
      label: COMPARISON_DIMENSION_LABELS[key],
      a: va,
      b: vb,
      delta: va === null || vb === null ? null : Number((vb - va).toFixed(3)),
    };
  });

  return {
    a,
    b,
    warnings,
    dimensions,
    metrics: {
      total_tokens: {
        a: a.total_tokens,
        b: b.total_tokens,
        delta: b.total_tokens - a.total_tokens,
      },
      total_cost: {
        a: a.total_cost,
        b: b.total_cost,
        delta: Number((b.total_cost - a.total_cost).toFixed(6)),
      },
      items: { a: rowsA.length, b: rowsB.length, matched },
    },
    item_stats,
    items,
  };
}
