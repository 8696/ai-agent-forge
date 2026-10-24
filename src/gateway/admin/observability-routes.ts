import Router from '@koa/router';
import { z } from 'zod';
import { jwtAuth } from '../jwt-base';
import { requireAdmin } from './middleware';
import { NotFoundError } from '../../lib/errors';
import type { TenantUserJwtPayload } from '../../lib/jwt';
import {
  getCostAnalysis,
  getObservabilitySummary,
  getTraceDetail,
  listTraces,
  type CostGroupBy,
  type CostRange,
} from '../../services/observability';

/**
 * 观测路由 —— D2（docs/12-d-需求-运维稳定.md §D2）
 * 路由前缀：/api/v1/admin　鉴权：admin 角色
 *
 * 端点：
 *   GET /observability/traces        trace 列表（分页 + 状态 / 用户 / 时间筛选）
 *   GET /observability/traces/:id    trace 详情（span 时间线）
 *   GET /observability/cost         成本分析（按天趋势 + 按维度拆解）
 *   GET /observability/summary      汇总指标（Dashboard 用）
 *
 * 跨租户隔离：tenant_id 一律从 JWT 取，查询里强制带上。
 */

export const adminObservabilityRouter = new Router({ prefix: '/api/v1/admin' });

adminObservabilityRouter.use(jwtAuth, requireAdmin);

function currentUser(ctx: { state: Record<string, unknown> }): TenantUserJwtPayload {
  return ctx.state.adminUser as TenantUserJwtPayload;
}

const traceListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['success', 'error']).optional(),
  user_id: z.string().trim().max(64).optional(),
  session_id: z.string().trim().max(64).optional(),
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
});

/** 解析 ISO 时间；解析不了就当没传（不因为一个坏参数让整个列表打不开） */
function parseDate(value: string | undefined): Date | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

adminObservabilityRouter.get('/observability/traces', async (ctx) => {
  const u = currentUser(ctx);
  const input = traceListQuerySchema.parse(ctx.query);
  ctx.body = await listTraces(u.tenant_id, {
    page: input.page,
    pageSize: input.page_size,
    status: input.status,
    userId: input.user_id,
    sessionId: input.session_id,
    from: parseDate(input.from),
    to: parseDate(input.to),
  });
});

adminObservabilityRouter.get('/observability/traces/:id', async (ctx) => {
  const u = currentUser(ctx);
  const detail = await getTraceDetail(u.tenant_id, ctx.params.id ?? '');
  if (detail === null) {
    throw new NotFoundError('trace');
  }
  ctx.body = detail;
});

const costQuerySchema = z.object({
  range: z.enum(['day', 'week', 'month', 'custom']).default('week'),
  group_by: z.enum(['model', 'user', 'channel', 'provider']).default('model'),
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
});

adminObservabilityRouter.get('/observability/cost', async (ctx) => {
  const u = currentUser(ctx);
  const input = costQuerySchema.parse(ctx.query);
  ctx.body = await getCostAnalysis(u.tenant_id, {
    range: input.range as CostRange,
    groupBy: input.group_by as CostGroupBy,
    from: parseDate(input.from),
    to: parseDate(input.to),
  });
});

adminObservabilityRouter.get('/observability/summary', async (ctx) => {
  const u = currentUser(ctx);
  ctx.body = await getObservabilitySummary(u.tenant_id);
});
