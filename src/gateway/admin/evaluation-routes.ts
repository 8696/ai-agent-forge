import Router from '@koa/router';
import { z } from 'zod';
import { jwtAuth } from '../jwt-base';
import { requireAdmin } from './middleware';
import { NotFoundError, ValidationError } from '../../lib/errors';
import { writeAuditLog } from '../../lib/audit-log';
import type { TenantUserJwtPayload } from '../../lib/jwt';
import {
  compareRuns,
  createDataset,
  deleteDataset,
  getDataset,
  getRun,
  listDatasets,
  listRunResults,
  listRuns,
  parseEvaluationJsonl,
  startEvaluationRun,
  type EvaluationItemInput,
} from '../../services/evaluation';

/**
 * 评测路由 —— D1（docs/12-d-需求-运维稳定.md §D1）
 * 路由前缀：/api/v1/admin　鉴权：admin 角色
 *
 * 端点：
 *   GET    /evaluation/datasets        评测集列表
 *   POST   /evaluation/datasets        新建评测集（items 数组或 JSONL 文本）
 *   GET    /evaluation/datasets/:id    评测集详情（题目预览）
 *   DELETE /evaluation/datasets/:id    删评测集
 *   GET    /evaluation/runs            跑批列表
 *   POST   /evaluation/runs            触发跑批（后台异步，立刻返回 run id）
 *                                         可选 prompt_version：指定用哪个提示词版本跑
 *   GET    /evaluation/runs/:id        跑批详情（含打分明细）
 *   GET    /evaluation/compare          对比两次跑批（A/B 对比）
 *                                         ?run_id_a=xxx&run_id_b=yyy
 *
 * 跨租户隔离：tenant_id 一律从 JWT 取，查询里强制带上。
 */

export const adminEvaluationRouter = new Router({ prefix: '/api/v1/admin' });

adminEvaluationRouter.use(jwtAuth, requireAdmin);

function currentUser(ctx: { state: Record<string, unknown> }): TenantUserJwtPayload {
  return ctx.state.adminUser as TenantUserJwtPayload;
}

const itemSchema = z.object({
  question: z.string().trim().min(1, 'question 不能为空').max(4000),
  reference_answer: z.string().trim().max(8000).nullish(),
  scenario: z.string().trim().max(64).nullish(),
  difficulty: z.string().trim().max(16).nullish(),
});

const createDatasetSchema = z
  .object({
    name: z.string().trim().min(1, '名称不能为空').max(100),
    version: z.string().trim().max(32).optional(),
    description: z.string().trim().max(500).nullish(),
    /** 直接给结构化题目 */
    items: z.array(itemSchema).max(1000).optional(),
    /** 或者给 JSONL 原文（每行一条） */
    jsonl: z.string().max(2_000_000).optional(),
  })
  .refine((v) => (v.items !== undefined) !== (v.jsonl !== undefined), {
    message: 'items 和 jsonl 只能给一个',
  });

adminEvaluationRouter.get('/evaluation/datasets', async (ctx) => {
  const u = currentUser(ctx);
  ctx.body = { datasets: await listDatasets(u.tenant_id) };
});

adminEvaluationRouter.post('/evaluation/datasets', async (ctx) => {
  const u = currentUser(ctx);
  const input = createDatasetSchema.parse(ctx.request.body ?? {});

  let items: EvaluationItemInput[];
  let parseErrors: Array<{ line: number; message: string }> = [];

  if (input.jsonl !== undefined) {
    const parsed = parseEvaluationJsonl(input.jsonl);
    items = parsed.items;
    parseErrors = parsed.errors;
  } else {
    items = (input.items ?? []).map((i) => ({
      question: i.question,
      reference_answer: i.reference_answer ?? null,
      scenario: i.scenario ?? null,
      difficulty: i.difficulty ?? null,
    }));
  }

  if (items.length === 0) {
    throw new ValidationError(
      parseErrors.length > 0
        ? `没有解析出任何题目（第 ${parseErrors[0]?.line} 行：${parseErrors[0]?.message}）`
        : '评测集至少要有 1 条题目',
    );
  }

  const dataset = await createDataset({
    tenantId: u.tenant_id,
    userId: u.sub,
    name: input.name,
    version: input.version,
    description: input.description ?? null,
    items,
  });

  await writeAuditLog({
    tenant_id: u.tenant_id,
    user_id: u.sub,
    action: 'EVALUATION_DATASET_CREATED',
    resource_type: 'evaluation_dataset',
    resource_id: dataset.id,
    details: { name: dataset.name, item_count: items.length },
  });

  ctx.status = 201;
  ctx.body = {
    id: dataset.id,
    name: dataset.name,
    version: dataset.version,
    item_count: dataset.item_count,
    // 坏行不拦整份上传，但要让用户知道哪几行没进去
    skipped: parseErrors,
  };
});

adminEvaluationRouter.get('/evaluation/datasets/:id', async (ctx) => {
  const u = currentUser(ctx);
  const detail = await getDataset(u.tenant_id, ctx.params.id ?? '');
  if (detail === null) {
    throw new NotFoundError('评测集');
  }
  ctx.body = detail;
});

adminEvaluationRouter.delete('/evaluation/datasets/:id', async (ctx) => {
  const u = currentUser(ctx);
  const deleted = await deleteDataset(u.tenant_id, ctx.params.id ?? '');
  if (!deleted) {
    throw new NotFoundError('评测集');
  }
  await writeAuditLog({
    tenant_id: u.tenant_id,
    user_id: u.sub,
    action: 'EVALUATION_DATASET_DELETED',
    resource_type: 'evaluation_dataset',
    resource_id: ctx.params.id ?? '',
  });
  ctx.status = 204;
});

const runListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
  dataset_id: z.string().trim().max(64).optional(),
});

adminEvaluationRouter.get('/evaluation/runs', async (ctx) => {
  const u = currentUser(ctx);
  const input = runListQuerySchema.parse(ctx.query);
  ctx.body = await listRuns(u.tenant_id, input.page, input.page_size, input.dataset_id);
});

const startRunSchema = z.object({
  dataset_id: z.string().trim().min(1, 'dataset_id 不能为空').max(64),
  /**
   * 指定用哪个提示词版本跑这一批 —— A/B 对比的前提。
   *
   * - 不传（undefined）= 跟随租户当前生效的提示词（原有行为）
   * - `null` / `''`     = 显式用内置默认提示词
   * - 具体版本号        = 用那个版本；不存在 → 400（**不回落**，回落会让对比结果骗人）
   */
  prompt_version: z.string().trim().max(64).nullish(),
});

adminEvaluationRouter.post('/evaluation/runs', async (ctx) => {
  const u = currentUser(ctx);
  const input = startRunSchema.parse(ctx.request.body ?? {});

  const run = await startEvaluationRun(u.tenant_id, u.sub, input.dataset_id, {
    promptVersion: input.prompt_version,
  });

  await writeAuditLog({
    tenant_id: u.tenant_id,
    user_id: u.sub,
    action: 'EVALUATION_RUN_STARTED',
    resource_type: 'evaluation_run',
    resource_id: run.id,
    details: {
      dataset_id: input.dataset_id,
      dataset_name: run.dataset_name,
      // 指定了版本才记 —— 「跟随生效版本」是默认行为，记下来全是噪音
      ...(input.prompt_version !== undefined && input.prompt_version !== null
        ? { prompt_version: input.prompt_version }
        : {}),
    },
  });

  ctx.status = 202;
  ctx.body = {
    id: run.id,
    status: run.status,
    total_items: run.total_items,
    completed_items: run.completed_items,
    started_at: run.started_at.toISOString(),
  };
});

/**
 * 对比两次跑批 —— A/B 对比（docs/12-e 裁定表 表 4）
 *
 * ⚠️ 路径是 `/evaluation/compare` 而不是 `/evaluation/runs/compare` ——
 *    后者会被 `/evaluation/runs/:id` 那个动态路由抢先匹配掉。
 */
const compareQuerySchema = z.object({
  run_id_a: z.string().trim().min(1, 'run_id_a 不能为空').max(64),
  run_id_b: z.string().trim().min(1, 'run_id_b 不能为空').max(64),
});

adminEvaluationRouter.get('/evaluation/compare', async (ctx) => {
  const u = currentUser(ctx);
  const input = compareQuerySchema.parse(ctx.query);
  ctx.body = await compareRuns(u.tenant_id, input.run_id_a, input.run_id_b);
});

adminEvaluationRouter.get('/evaluation/runs/:id', async (ctx) => {
  const u = currentUser(ctx);
  const runId = ctx.params.id ?? '';
  const run = await getRun(u.tenant_id, runId);
  if (run === null) {
    throw new NotFoundError('评测跑批');
  }
  const query = runListQuerySchema.parse(ctx.query);
  const results = await listRunResults(u.tenant_id, runId, query.page, query.page_size);
  ctx.body = { run, ...results };
});
