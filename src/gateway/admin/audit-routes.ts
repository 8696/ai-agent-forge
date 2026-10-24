import Router from '@koa/router';
import type { Context } from 'koa';
import { z } from 'zod';
import { jwtAuth } from '../jwt-base';
import { requireAdmin } from './middleware';
import type { TenantUserJwtPayload } from '../../lib/jwt';
import { listAuditActions, listAuditLogs } from '../../lib/audit-log';

/**
 * 审计日志路由 —— D5（docs/12-d-需求-运维稳定.md §D5）的读侧
 * 路由前缀：/api/v1/admin　鉴权：admin 角色
 *
 * 端点：
 *   GET /audit           审计日志列表（分页 + 用户 / 时间 / 操作类型筛选）
 *   GET /audit/actions   本租户日志里出现过的操作类型（给筛选下拉框用）
 *
 * 跨租户隔离：tenant_id 一律从 JWT 取，查询里强制带上。
 * 系统级日志（tenant_id IS NULL —— 平台方改租户启停那类）**不会**出现在这里，
 * 详见 listAuditLogs 的注释。
 *
 * ⚠️ **本文件的路由当前是临时挂在 adminUserRouter 上的**
 *    （见 src/gateway/admin/index.ts）—— 因为本轮不能动 src/server.ts。
 *    迁移到 server.ts 常规注册方式后，这里的 export 也要一起挪。
 */

export const adminAuditRouter = new Router({ prefix: '/api/v1/admin' });

adminAuditRouter.use(jwtAuth, requireAdmin);

const auditListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
  /** 操作者 id */
  user_id: z.string().trim().max(64).optional(),
  /** 操作类型（精确匹配） */
  action: z.string().trim().max(100).optional(),
  /** 资源类型（精确匹配） */
  resource_type: z.string().trim().max(100).optional(),
  /** 起始时间（ISO 8601） */
  from: z.string().trim().optional(),
  /** 结束时间（ISO 8601） */
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

function currentUser(ctx: { state: Record<string, unknown> }): TenantUserJwtPayload {
  return ctx.state.adminUser as TenantUserJwtPayload;
}

/**
 * GET /audit —— 列本租户审计日志
 *
 * 响应：{ logs: [...], pagination: { page, page_size, total, total_pages } }
 */
export async function auditListHandler(ctx: Context): Promise<void> {
  const u = currentUser(ctx);
  const input = auditListQuerySchema.parse(ctx.query);
  ctx.body = await listAuditLogs(u.tenant_id, {
    page: input.page,
    pageSize: input.page_size,
    userId: input.user_id,
    action: input.action,
    resourceType: input.resource_type,
    from: parseDate(input.from),
    to: parseDate(input.to),
  });
}

/**
 * GET /audit/actions —— 本租户日志里出现过的操作类型
 *
 * 给前端的「操作类型」筛选下拉框用。用真实数据而不是硬编码枚举，
 * 这样新增的 action 不用改前端就出现在下拉框里。
 */
export async function auditActionsHandler(ctx: Context): Promise<void> {
  const u = currentUser(ctx);
  ctx.body = { actions: await listAuditActions(u.tenant_id) };
}

adminAuditRouter.get('/audit', auditListHandler);
adminAuditRouter.get('/audit/actions', auditActionsHandler);
