import Router from '@koa/router';
import type { Context } from 'koa';
import { z } from 'zod';
import { jwtAuth } from '../jwt-base';
import { requireSystemUser } from './middleware';
import { listAllAuditActions, listAllAuditLogs } from '../../lib/audit-log';

/**
 * 平台方的审计日志路由 —— docs/04-d-ui-系统级与公共组件.md §6.1
 *
 * 路由前缀：/api/v1/system　鉴权：system 角色
 *
 * 端点：
 *   GET /audit           全部审计日志（**跨租户 + 含系统级日志**）
 *   GET /audit/actions   全部日志里出现过的操作类型（筛选下拉框用）
 *
 * ## 跟租户后台的 /admin/audit 有什么区别
 *
 * | | `/api/v1/admin/audit`（租户 admin） | `/api/v1/system/audit`（平台方） |
 * |---|---|---|
 * | 范围 | 只有本租户 | **全部租户 + 系统级日志** |
 * | 系统级日志（tenant_id 为空） | ❌ 看不到（`tenant_id = 'x'` 天然排除 NULL） | ✅ 能看到 |
 * | 租户隔离 | 强制 `tenant_id = JWT.tenant_id` | 无租户过滤（平台方视角） |
 *
 * ⚠️ **跨租户是故意的** —— 这是平台方的特权视角，不是隔离漏洞。
 *    租户 admin 那条路仍然强制带 `tenant_id`（见 listAuditLogs 的注释）。
 */
export const systemAuditRouter = new Router({ prefix: '/api/v1/system' });

systemAuditRouter.use(jwtAuth, requireSystemUser);

const systemAuditQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
  /** 按租户过滤（不传 = 全部租户 + 系统级） */
  tenant_id: z.string().trim().max(64).optional(),
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

systemAuditRouter.get('/audit', async (ctx: Context) => {
  const input = systemAuditQuerySchema.parse(ctx.query);
  ctx.body = await listAllAuditLogs({
    page: input.page,
    pageSize: input.page_size,
    tenantId: input.tenant_id,
    userId: input.user_id,
    action: input.action,
    resourceType: input.resource_type,
    from: parseDate(input.from),
    to: parseDate(input.to),
  });
});

systemAuditRouter.get('/audit/actions', async (ctx: Context) => {
  ctx.body = { actions: await listAllAuditActions() };
});
