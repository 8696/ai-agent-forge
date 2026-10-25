import Router from '@koa/router';
import type { Context } from 'koa';
import { z } from 'zod';
import { jwtAuth } from '../jwt-base';
import { requireAdmin } from './middleware';
import { writeAuditLog } from '../../lib/audit-log';
import { ValidationError } from '../../lib/errors';
import type { TenantUserJwtPayload } from '../../lib/jwt';
import { createTool, deleteTool, getTool, listTools, toToolView, updateTool } from '../../services/tools';
import { listBuiltinTools, getBuiltinTool } from '../../tools/builtin/registry';
import { TOOL_TIMEOUT_MS } from '../../tools/execute';

/**
 * 工具管理路由 —— C2（docs/12-c-需求-管理员可配置.md §C2）
 * 路由前缀：/api/v1/admin　鉴权：admin 角色
 *
 * 端点：
 *   GET    /tools              本租户工具列表
 *   GET    /tools/builtins     平台内置工具清单（注册时的下拉框）
 *   POST   /tools              注册工具
 *   PATCH  /tools/:id          改描述 / 启停 / 敏感标记
 *   DELETE /tools/:id          删
 *   POST   /tools/:id/test     试连一次
 *
 * 跨租户隔离：`tenant_id` 一律从 JWT 取（**不接受请求体里的 tenant_id**），
 * 查询强制带上 —— 别的租户的工具按 id 取也是 404。
 */
export const adminToolRouter = new Router({ prefix: '/api/v1/admin' });

adminToolRouter.use(jwtAuth, requireAdmin);

function currentUser(ctx: { state: Record<string, unknown> }): TenantUserJwtPayload {
  return ctx.state.adminUser as TenantUserJwtPayload;
}

const toolTypeSchema = z.enum(['builtin', 'http', 'mcp']);

const createBodySchema = z.object({
  /** 调用名（英文标识符） */
  name: z.string().trim().min(1).max(64),
  /** 给模型看的描述（不填就用内置实现的默认描述） */
  description: z.string().trim().max(1000).optional(),
  type: toolTypeSchema.default('builtin'),
  /** 内置实现 key（type='builtin' 时必填） */
  builtin: z.string().trim().max(64).optional(),
  enabled: z.boolean().optional(),
  requires_confirmation: z.boolean().optional(),
});

const patchBodySchema = z.object({
  description: z.string().trim().max(1000).optional(),
  enabled: z.boolean().optional(),
  requires_confirmation: z.boolean().optional(),
});

const testBodySchema = z.object({
  /** 试连用的入参；不传就用内置实现的样例入参 */
  args: z.unknown().optional(),
});

/** GET /tools —— 本租户工具列表 */
adminToolRouter.get('/tools', async (ctx: Context) => {
  const u = currentUser(ctx);
  ctx.body = { tools: await listTools(u.tenant_id) };
});

/**
 * GET /tools/builtins —— 平台内置工具清单
 *
 * 注册时的下拉框用。**只暴露元信息**（key / 名称 / 描述 / 是否敏感 / 样例入参），
 * 实现细节不外泄。
 */
adminToolRouter.get('/tools/builtins', async (ctx: Context) => {
  ctx.body = {
    builtins: listBuiltinTools().map((impl) => ({
      key: impl.key,
      name: impl.name,
      description: impl.description,
      sensitive: impl.sensitive,
      sample_args: impl.sampleArgs,
    })),
  };
});

/** POST /tools —— 注册工具 */
adminToolRouter.post('/tools', async (ctx: Context) => {
  const u = currentUser(ctx);
  const input = createBodySchema.parse(ctx.request.body ?? {});

  const row = await createTool(u.tenant_id, u.sub, {
    name: input.name,
    description: input.description,
    type: input.type,
    builtin: input.builtin,
    enabled: input.enabled,
    requires_confirmation: input.requires_confirmation,
  });

  await writeAuditLog({
    tenant_id: u.tenant_id,
    user_id: u.sub,
    action: 'TOOL_CREATED',
    resource_type: 'tool',
    resource_id: row.id,
    details: { name: row.name, type: row.type, builtin: row.config?.builtin ?? null },
    ip: ctx.ip,
  });

  ctx.status = 201;
  ctx.body = { tool: toToolView(row) };
});

/** PATCH /tools/:id —— 改描述 / 启停 / 敏感标记 */
adminToolRouter.patch('/tools/:id', async (ctx: Context) => {
  const u = currentUser(ctx);
  const id = ctx.params.id ?? '';
  const input = patchBodySchema.parse(ctx.request.body ?? {});

  const before = await getTool(u.tenant_id, id);
  const beforeEnabled = before.enabled;
  const row = await updateTool(u.tenant_id, id, input, u.sub);

  if (input.enabled !== undefined && input.enabled !== beforeEnabled) {
    await writeAuditLog({
      tenant_id: u.tenant_id,
      user_id: u.sub,
      action: input.enabled ? 'TOOL_ENABLED' : 'TOOL_DISABLED',
      resource_type: 'tool',
      resource_id: row.id,
      details: { name: row.name, enabled: row.enabled },
      ip: ctx.ip,
    });
  }

  await writeAuditLog({
    tenant_id: u.tenant_id,
    user_id: u.sub,
    action: 'TOOL_UPDATED',
    resource_type: 'tool',
    resource_id: row.id,
    details: {
      name: row.name,
      description_changed: input.description !== undefined,
      requires_confirmation: row.requires_confirmation,
    },
    ip: ctx.ip,
  });

  ctx.body = { tool: toToolView(row) };
});

/** DELETE /tools/:id —— 删 */
adminToolRouter.delete('/tools/:id', async (ctx: Context) => {
  const u = currentUser(ctx);
  const id = ctx.params.id ?? '';

  const row = await getTool(u.tenant_id, id);
  await deleteTool(u.tenant_id, id);

  await writeAuditLog({
    tenant_id: u.tenant_id,
    user_id: u.sub,
    action: 'TOOL_DELETED',
    resource_type: 'tool',
    resource_id: row.id,
    details: { name: row.name, type: row.type },
    ip: ctx.ip,
  });

  ctx.status = 204;
});

/**
 * POST /tools/:id/test —— 试连一次
 *
 * 内置工具直接用实现跑一次（传样例入参，或调用方给的入参）。
 * 返回真实结果 + 耗时 —— 租户能当场确认「这个工具调得通」。
 */
adminToolRouter.post('/tools/:id/test', async (ctx: Context) => {
  const u = currentUser(ctx);
  const id = ctx.params.id ?? '';
  const input = testBodySchema.parse(ctx.request.body ?? {});

  const row = await getTool(u.tenant_id, id);
  const builtinKey = row.config?.builtin;
  const impl = typeof builtinKey === 'string' ? getBuiltinTool(builtinKey) : undefined;
  if (impl === undefined) {
    throw new ValidationError('这条工具的实现已经不存在了（可能已下架），请重新注册');
  }

  const args = input.args === undefined ? impl.sampleArgs : input.args;
  const started = Date.now();
  try {
    const output = await impl.execute(
      { tenantId: u.tenant_id, sessionId: null, userId: u.sub },
      args,
    );
    ctx.body = {
      ok: true,
      output,
      took_ms: Date.now() - started,
      timeout_ms: TOOL_TIMEOUT_MS,
    };
  } catch (err: unknown) {
    ctx.body = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      took_ms: Date.now() - started,
      timeout_ms: TOOL_TIMEOUT_MS,
    };
  }
});

/** 404 兜底：让「打错的工具端点」返回像样的 404 而不是默认的 HTML */
adminToolRouter.get('/tools/:id', async (ctx: Context) => {
  const u = currentUser(ctx);
  const id = ctx.params.id ?? '';
  const row = await getTool(u.tenant_id, id);
  ctx.body = { tool: toToolView(row) };
});
