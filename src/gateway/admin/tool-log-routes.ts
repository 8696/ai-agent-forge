import Router from '@koa/router';
import type { Context } from 'koa';
import { z } from 'zod';
import { jwtAuth } from '../jwt-base';
import { requireAdmin } from './middleware';
import type { TenantUserJwtPayload } from '../../lib/jwt';
import {
  getToolCallLog,
  listToolCallLogs,
  listToolCallNames,
  toToolCallLogView,
} from '../../services/tool-call-logs';

/**
 * 工具调用记录路由 —— B3 工具调用（docs/12-b-需求-ai对话能力.md §B3）
 * 路由前缀：/api/v1/admin　鉴权：admin 角色
 *
 * 端点：
 *   GET /tool-logs        调用流水列表（分页 + 工具 / 状态 / 时间 / 关键词筛选）
 *   GET /tool-logs/names  本租户调用过的工具名（筛选下拉框用）
 *   GET /tool-logs/:id    单条详情
 *
 * 跨租户隔离：`tenant_id` 一律从 JWT 取，查询强制带上 ——
 * 别的租户的工具调用记录按 id 取也是 404。
 *
 * 一行 = 一次工具调用，带**请求参数**（模型给的入参）和**响应参数**（工具的返回值）。
 */
export const adminToolLogRouter = new Router({ prefix: '/api/v1/admin' });

adminToolLogRouter.use(jwtAuth, requireAdmin);

function currentUser(ctx: { state: Record<string, unknown> }): TenantUserJwtPayload {
  return ctx.state.adminUser as TenantUserJwtPayload;
}

const toolCallLogListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
  /** 按工具名精确筛 */
  tool_name: z.string().trim().max(100).optional(),
  /** 按状态精确筛 */
  status: z.enum(['ok', 'error', 'timeout', 'awaiting_confirmation']).optional(),
  /** 按会话筛 */
  session_id: z.string().trim().max(64).optional(),
  /** 起始时间（ISO 8601） */
  from: z.string().trim().optional(),
  /** 结束时间（ISO 8601） */
  to: z.string().trim().optional(),
  /** 模糊搜：入参 / 返回值里包含这个串（比如某个订单号） */
  keyword: z.string().trim().max(200).optional(),
});

/** 解析 ISO 时间；解析不了就当没传（不因为一个坏参数让整个列表打不开） */
function parseDate(value: string | undefined): Date | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * GET /tool-logs —— 工具调用流水
 *
 * 响应：{ logs: [...], pagination: { page, page_size, total, total_pages } }
 */
adminToolLogRouter.get('/tool-logs', async (ctx: Context) => {
  const u = currentUser(ctx);
  const input = toolCallLogListQuerySchema.parse(ctx.query);
  ctx.body = await listToolCallLogs(u.tenant_id, {
    page: input.page,
    pageSize: input.page_size,
    toolName: input.tool_name,
    status: input.status,
    sessionId: input.session_id,
    from: parseDate(input.from),
    to: parseDate(input.to),
    keyword: input.keyword,
  });
});

/** GET /tool-logs/names —— 本租户调用过的工具名（筛选下拉框） */
adminToolLogRouter.get('/tool-logs/names', async (ctx: Context) => {
  const u = currentUser(ctx);
  ctx.body = { names: await listToolCallNames(u.tenant_id) };
});

/** GET /tool-logs/:id —— 单条详情 */
adminToolLogRouter.get('/tool-logs/:id', async (ctx: Context) => {
  const u = currentUser(ctx);
  const row = await getToolCallLog(u.tenant_id, ctx.params.id ?? '');
  ctx.body = { log: toToolCallLogView(row) };
});
