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
import { createHttpToolImpl } from '../../tools/http-mock';
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

/**
 * 工具类型。
 *
 * ⚠️ **`mcp` 不开放** —— 涉及多个系统（租户那边得自己跑 MCP server），
 *    「当前一个系统做完」做不到。见 12-e 需求裁定表 #1。
 * ⚠️ **`http` 是「本地 mock」** —— 保留 url/method 的配置形状，
 *    但平台**不真的发请求**，按 `(租户, url, method, 入参)` 确定性生成响应。
 *    见 12-e 需求裁定表 #2。
 */
const toolTypeSchema = z.enum(['builtin', 'http']);

const createBodySchema = z.object({
  /** 调用名（英文标识符） */
  name: z.string().trim().min(1).max(64),
  /** 给模型看的描述（不填就用内置实现的默认描述） */
  description: z.string().trim().max(1000).optional(),
  type: toolTypeSchema.default('builtin'),
  /** 内置实现 key（type='builtin' 时必填） */
  builtin: z.string().trim().max(64).optional(),
  /** http 类型的目标地址（**只做展示与 mock 依据，不真出网**） */
  url: z.string().trim().max(500).optional(),
  /** http 类型的方法 */
  method: z.string().trim().max(10).optional(),
  /** http 类型的模拟响应原文（填了就用它） */
  mock_response: z.unknown().optional(),
  /** http 类型的模拟状态码 */
  mock_status: z.number().int().optional(),
  /** http 类型的入参字段声明 */
  input_fields: z.unknown().optional(),
  enabled: z.boolean().optional(),
  requires_confirmation: z.boolean().optional(),
});

const patchBodySchema = z.object({
  description: z.string().trim().max(1000).optional(),
  enabled: z.boolean().optional(),
  requires_confirmation: z.boolean().optional(),
  /** http 类型：接口配置可以改（url / method 不是模型的调用名） */
  url: z.string().trim().max(500).optional(),
  method: z.string().trim().max(10).optional(),
  mock_response: z.unknown().optional(),
  mock_status: z.number().int().optional(),
  input_fields: z.unknown().optional(),
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
    url: input.url,
    method: input.method,
    mock_response: input.mock_response,
    mock_status: input.mock_status,
    input_fields: input.input_fields,
    enabled: input.enabled,
    requires_confirmation: input.requires_confirmation,
  });

  await writeAuditLog({
    tenant_id: u.tenant_id,
    user_id: u.sub,
    action: 'TOOL_CREATED',
    resource_type: 'tool',
    resource_id: row.id,
    details: {
      name: row.name,
      type: row.type,
      builtin: row.config?.builtin ?? null,
      // http 类型记一下指向哪个接口（**不记 mock_response 原文** —— 可能含敏感内容）
      url: row.config?.url ?? null,
    },
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
 * **http 类型（本地 mock）** 按它的 config 动态造实现再跑。
 * 返回真实结果 + 耗时 —— 租户能当场确认「这个工具调得通」。
 */
adminToolRouter.post('/tools/:id/test', async (ctx: Context) => {
  const u = currentUser(ctx);
  const id = ctx.params.id ?? '';
  const input = testBodySchema.parse(ctx.request.body ?? {});

  const row = await getTool(u.tenant_id, id);
  // http 类型的实现是动态的（入参 schema 来自租户声明的字段），按 config 现造
  const impl =
    row.type === 'http'
      ? createHttpToolImpl(row.config ?? {}, row.name)
      : (() => {
          const builtinKey = row.config?.builtin;
          return typeof builtinKey === 'string' ? getBuiltinTool(builtinKey) : undefined;
        })();
  if (impl === undefined || impl === null) {
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
