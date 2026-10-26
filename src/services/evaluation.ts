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
import { resolveTenantPrompt } from './prompt-registry';
import { recordLlmUsage } from './cost-tracking';
import { writeAuditLog } from '../lib/audit-log';
import { JUDGE_SYSTEM_PROMPT, renderJudgeInput } from '../prompts/evaluation';
import { ValidationError } from '../lib/errors';

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
 */
export async function startEvaluationRun(
  tenantId: string,
  userId: string | null,
  datasetId: string,
  options?: { limit?: number | undefined; trigger?: EvaluationRunTrigger | undefined },
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
    started_at: new Date(),
  });

  // 后台跑，不 await —— 错误在 executeRun 内部兜住并写进 run 行
  void executeRun(run.id, tenantId, datasetId, limit);

  return run;
}

/**
 * 跑批的主循环 —— 每条题：生成 → 裁判 → 落明细
 *
 * @param itemLimit 只跑前 N 题（不传 = 跑全集）
 */
async function executeRun(
  runId: string,
  tenantId: string,
  datasetId: string,
  itemLimit?: number | undefined,
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
    const resolvedPrompt = await resolveTenantPrompt(
      tenantId,
      llm.promptVersion,
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
