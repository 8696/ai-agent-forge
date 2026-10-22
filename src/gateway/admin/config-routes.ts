import Router from '@koa/router';
import { z } from 'zod';
import { Tenant, PromptVersion } from '../../models';
import { jwtAuth } from '../jwt-base';
import { requireAdmin } from './middleware';
import { ValidationError, NotFoundError } from '../../lib/errors';
import { writeAuditLog } from '../../lib/audit-log';
import { isSecretEncryptionEnabled, decryptSecret } from '../../lib/crypto';
import { describeProcessLlmDefaults } from '../../services/llm-settings';
import {
  activateTenantModel,
  createTenantModel,
  deleteTenantModel,
  getTenantModel,
  listTenantModels,
  normalizeModelInput,
  toModelView,
  updateTenantModel,
} from '../../services/tenant-models';
import {
  listSettings,
  saveSettings,
  getSettingValue,
  SETTINGS_REGISTRY,
} from '../../services/tenant-settings';
import {
  builtinPrompt,
  createPromptVersion,
  deletePromptVersion,
  listPromptVersions,
  publishPromptVersion,
  updatePromptDraft,
} from '../../services/prompt-registry';
import type { TenantUserJwtPayload } from '../../lib/jwt';

/**
 * 租户级配置路由 —— docs/12-c §C3（提示词配置）/ §C4（模型选择）、docs/12-e §E2
 * 路由前缀：/api/v1/admin　鉴权：admin 角色
 *
 * 按「不同形态用不同页面」分成三组：
 *
 *   模型   /config/models*    一个租户可配多条，逐条切换（is_active 标记当前使用）
 *   提示词 /config/prompts*   版本列表 + 草稿 / 发布 / 回滚
 *   通用   /config/settings*  KV 结构，承接零散参数（检索条数 / 历史轮数 …）
 *
 * **密钥铁律**：读接口只返回 `has_api_key` + `api_key_hint`（形如 `sk-…4f2a`），
 * 密文和明文都不出这个文件。编辑时不带 api_key 字段 = 保持原样。
 *
 * 跨租户隔离：所有查询强制带 ctx.state.adminUser.tenant_id。
 */

export const adminConfigRouter = new Router({ prefix: '/api/v1/admin' });

adminConfigRouter.use(jwtAuth, requireAdmin);

function currentUser(ctx: { state: Record<string, unknown> }): TenantUserJwtPayload {
  return ctx.state.adminUser as TenantUserJwtPayload;
}

// ============================================================
// 模型列表（C4）
// ============================================================

adminConfigRouter.get('/config/models', async (ctx) => {
  const u = currentUser(ctx);
  ctx.body = {
    models: await listTenantModels(u.tenant_id),
    process_defaults: describeProcessLlmDefaults(),
    secret_encryption_enabled: isSecretEncryptionEnabled(),
    notes: [
      '每条模型是一套完整连接配置（端点 + 密钥 + 采样参数），互不共享。',
      '第一条模型会自动成为「启用中」，之后可随时切换。',
      '没有启用中的模型时，对话走平台默认（.env 里配好的那个）。',
      'API Key 只写不读：保存后只显示脱敏串，原始值无法再取回。',
    ],
  };
});

const modelBodySchema = z.object({
  name: z.string().trim().min(1, '名称不能为空').max(100),
  provider: z.string().trim().max(32).nullish(),
  model_id: z.string().trim().min(1, '模型 id 不能为空').max(100),
  base_url: z.string().trim().min(1, 'Base URL 不能为空').max(500),
  /** 只写：不带 = 保持原样（编辑时不必重填），带字符串 = 换新 */
  api_key: z.string().min(1).max(500).optional(),
  temperature: z.number().min(0).max(2).nullish(),
  max_output_tokens: z.number().int().min(64).max(32768).nullish(),
  prompt_cache_enabled: z.boolean().nullish(),
});

adminConfigRouter.post('/config/models', async (ctx) => {
  const u = currentUser(ctx);
  const input = modelBodySchema.parse(ctx.request.body);
  const row = await createTenantModel(u.tenant_id, u.sub, {
    name: input.name,
    provider: input.provider ?? null,
    model_id: input.model_id,
    base_url: input.base_url,
    api_key: input.api_key,
    temperature: input.temperature ?? null,
    max_output_tokens: input.max_output_tokens ?? null,
    prompt_cache_enabled: input.prompt_cache_enabled ?? true,
  });
  await writeAuditLog({
    tenant_id: u.tenant_id,
    user_id: u.sub,
    action: 'TENANT_MODEL_CREATE',
    resource_type: 'tenant_model',
    resource_id: row.id,
    details: { name: row.name, model_id: row.model_id, is_active: row.is_active },
    ip: ctx.ip,
  });
  ctx.status = 201;
  ctx.body = toModelView(row);
});

adminConfigRouter.put('/config/models/:id', async (ctx) => {
  const u = currentUser(ctx);
  const input = modelBodySchema.parse(ctx.request.body);
  const row = await updateTenantModel(u.tenant_id, ctx.params.id ?? '', u.sub, {
    name: input.name,
    provider: input.provider ?? null,
    model_id: input.model_id,
    base_url: input.base_url,
    api_key: input.api_key,
    temperature: input.temperature ?? null,
    max_output_tokens: input.max_output_tokens ?? null,
    prompt_cache_enabled: input.prompt_cache_enabled ?? true,
  });
  await writeAuditLog({
    tenant_id: u.tenant_id,
    user_id: u.sub,
    action: 'TENANT_MODEL_UPDATE',
    resource_type: 'tenant_model',
    resource_id: row.id,
    details: { name: row.name, api_key_rotated: input.api_key !== undefined },
    ip: ctx.ip,
  });
  ctx.body = toModelView(row);
});

adminConfigRouter.post('/config/models/:id/activate', async (ctx) => {
  const u = currentUser(ctx);
  const previous = (await listTenantModels(u.tenant_id)).find((m) => m.is_active) ?? null;
  const row = await activateTenantModel(u.tenant_id, ctx.params.id ?? '');
  await writeAuditLog({
    tenant_id: u.tenant_id,
    user_id: u.sub,
    action: 'TENANT_MODEL_ACTIVATE',
    resource_type: 'tenant_model',
    resource_id: row.id,
    details: { from: previous?.name ?? null, to: row.name },
    ip: ctx.ip,
  });
  ctx.body = toModelView(row);
});

adminConfigRouter.delete('/config/models/:id', async (ctx) => {
  const u = currentUser(ctx);
  const row = await getTenantModel(u.tenant_id, ctx.params.id ?? '');
  await deleteTenantModel(u.tenant_id, row.id);
  await writeAuditLog({
    tenant_id: u.tenant_id,
    user_id: u.sub,
    action: 'TENANT_MODEL_DELETE',
    resource_type: 'tenant_model',
    resource_id: row.id,
    details: { name: row.name },
    ip: ctx.ip,
  });
  ctx.status = 204;
});

/**
 * 试连：按某条模型真发一次最小请求。**不落 messages 表**，也不产生对话历史。
 * 失败返回 200 + {ok:false} —— 试连失败是「结果」，不是接口错误。
 */
adminConfigRouter.post('/config/models/:id/test', async (ctx) => {
  const { createAnthropic } = await import('@ai-sdk/anthropic');
  const { generateText } = await import('ai');

  const u = currentUser(ctx);
  const startedAt = Date.now();
  try {
    const row = await getTenantModel(u.tenant_id, ctx.params.id ?? '');
    const apiKey = decryptSecret(row.api_key_enc);
    const anthropic = createAnthropic({ apiKey, baseURL: row.base_url });
    const res = await generateText({
      model: anthropic(row.model_id),
      prompt: '回复两个字：正常',
      maxOutputTokens: 16,
      temperature: 0,
    });
    ctx.body = {
      ok: true,
      took_ms: Date.now() - startedAt,
      provider: row.provider ?? 'custom',
      model: row.model_id,
      output: res.text,
    };
  } catch (err: unknown) {
    ctx.status = 200;
    ctx.body = {
      ok: false,
      took_ms: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  }
});

/** 校验一个 Base URL 能不能用（保存表单时前端调，避免存进去才发现打不通） */
adminConfigRouter.post('/config/models/check-endpoint', async (ctx) => {
  const { checkLlmEndpoint } = await import('../../lib/llm-endpoint');
  const parsed = z.object({ base_url: z.string().min(1) }).parse(ctx.request.body);
  ctx.body = await checkLlmEndpoint(parsed.base_url);
});

// ============================================================
// 通用配置（KV）
// ============================================================

adminConfigRouter.get('/config/settings', async (ctx) => {
  const u = currentUser(ctx);
  ctx.body = {
    settings: await listSettings(u.tenant_id),
    groups: [...new Set(SETTINGS_REGISTRY.map((s) => s.category))],
    notes: [
      '每一项都是「平台默认 + 租户可覆盖」，清空即回落平台默认。',
      '安全与成本相关的参数（加密密钥、SSRF 开关、上下文总预算）留在服务端 .env，不在这里暴露。',
    ],
  };
});

/** 批量保存：`{ key: 值 }`；值为 null 表示清除覆盖、回落平台默认 */
adminConfigRouter.put('/config/settings', async (ctx) => {
  const u = currentUser(ctx);
  const payload = ctx.request.body;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new ValidationError('请求体必须是 { key: 值 } 的对象');
  }
  const before = await listSettings(u.tenant_id);
  await saveSettings(u.tenant_id, u.sub, payload as Record<string, unknown>);
  const after = await listSettings(u.tenant_id);
  await writeAuditLog({
    tenant_id: u.tenant_id,
    user_id: u.sub,
    action: 'TENANT_SETTINGS_CHANGE',
    resource_type: 'tenant_setting',
    resource_id: null,
    details: { before, after },
    ip: ctx.ip,
  });
  ctx.body = { settings: after };
});

// ============================================================
// 提示词版本（C3）
// ============================================================

/** 取本租户当前生效的提示词版本号（列表页用来标 in_use） */
async function activePromptVersion(tenantId: string): Promise<string | null> {
  const v = await getSettingValue(tenantId, 'prompt_version');
  return typeof v === 'string' ? v : null;
}

/** 发布 / 回滚后把租户的「当前生效版本」指过去（写 tenant_settings 的 KV） */
async function setActivePromptVersion(
  tenantId: string,
  userId: string,
  version: string,
): Promise<void> {
  await saveSettings(tenantId, userId, { prompt_version: version });
}

adminConfigRouter.get('/config/prompts', async (ctx) => {
  const u = currentUser(ctx);
  const active = await activePromptVersion(u.tenant_id);
  ctx.body = { versions: await listPromptVersions(u.tenant_id, active) };
});

adminConfigRouter.get('/config/prompts/default', async (ctx) => {
  const tenant = await Tenant.findByPk(currentUser(ctx).tenant_id);
  const builtin = builtinPrompt(tenant?.name ?? '本公司');
  ctx.body = { content: builtin.text, version: builtin.version };
});

/**
 * 取单个版本的正文。
 *
 * 列表接口**故意不返回 content** —— 十几个版本的全文加起来几十 KB，
 * 打开页面全量拉一遍很浪费。编辑区按需单条取。
 */
adminConfigRouter.get('/config/prompts/:version', async (ctx) => {
  const u = currentUser(ctx);
  const row = await PromptVersion.findOne({
    where: { tenant_id: u.tenant_id, version: ctx.params.version ?? '' },
  });
  if (row === null) {
    throw new NotFoundError('提示词版本');
  }
  ctx.body = {
    version: row.version,
    status: row.status,
    content: row.content,
    description: row.description,
    updated_at: row.updated_at.toISOString(),
  };
});

const createVersionBodySchema = z.object({
  version: z.string().trim().min(1).max(20),
  content: z.string().min(1),
  description: z.string().trim().max(200).nullish(),
});

adminConfigRouter.post('/config/prompts', async (ctx) => {
  const u = currentUser(ctx);
  const input = createVersionBodySchema.parse(ctx.request.body);
  const row = await createPromptVersion({
    tenantId: u.tenant_id,
    userId: u.sub,
    version: input.version,
    content: input.content,
    description: input.description ?? undefined,
  });
  await writeAuditLog({
    tenant_id: u.tenant_id,
    user_id: u.sub,
    action: 'PROMPT_VERSION_CREATE',
    resource_type: 'prompt_version',
    resource_id: row.id,
    details: { version: row.version },
    ip: ctx.ip,
  });
  ctx.status = 201;
  ctx.body = { id: row.id, version: row.version, status: row.status };
});

const updateVersionBodySchema = z.object({
  content: z.string().min(1),
  description: z.string().trim().max(200).nullish(),
});

adminConfigRouter.put('/config/prompts/:version', async (ctx) => {
  const u = currentUser(ctx);
  const input = updateVersionBodySchema.parse(ctx.request.body);
  const row = await updatePromptDraft({
    tenantId: u.tenant_id,
    version: ctx.params.version ?? '',
    content: input.content,
    description: input.description ?? undefined,
  });
  ctx.body = { id: row.id, version: row.version, status: row.status };
});

adminConfigRouter.post('/config/prompts/:version/publish', async (ctx) => {
  const u = currentUser(ctx);
  const version = ctx.params.version ?? '';
  const previous = await activePromptVersion(u.tenant_id);
  const row = await publishPromptVersion({ tenantId: u.tenant_id, version, userId: u.sub });

  // 发布要顺带把租户的「当前生效版本」指过去，否则光改 status 对话不会变
  await setActivePromptVersion(u.tenant_id, u.sub, row.version);

  await writeAuditLog({
    tenant_id: u.tenant_id,
    user_id: u.sub,
    action: 'PROMPT_PUBLISH',
    resource_type: 'prompt_version',
    resource_id: row.id,
    details: { from: previous, to: row.version },
    ip: ctx.ip,
  });
  ctx.body = {
    version: row.version,
    status: row.status,
    deployed_at: row.deployed_at?.toISOString() ?? null,
  };
});

adminConfigRouter.delete('/config/prompts/:version', async (ctx) => {
  const u = currentUser(ctx);
  const version = ctx.params.version ?? '';
  await deletePromptVersion(u.tenant_id, version);
  await writeAuditLog({
    tenant_id: u.tenant_id,
    user_id: u.sub,
    action: 'PROMPT_VERSION_DELETE',
    resource_type: 'prompt_version',
    resource_id: null,
    details: { version },
    ip: ctx.ip,
  });
  ctx.status = 204;
});

/** 回滚 = 把历史版本重新发布一次（版本号不变，status 来回切） */
adminConfigRouter.post('/config/prompts/:version/rollback', async (ctx) => {
  const u = currentUser(ctx);
  const version = ctx.params.version ?? '';
  const exists = await PromptVersion.findOne({ where: { tenant_id: u.tenant_id, version } });
  if (exists === null) {
    throw new NotFoundError('提示词版本');
  }
  const previous = await activePromptVersion(u.tenant_id);
  const row = await publishPromptVersion({ tenantId: u.tenant_id, version, userId: u.sub });
  await setActivePromptVersion(u.tenant_id, u.sub, row.version);

  await writeAuditLog({
    tenant_id: u.tenant_id,
    user_id: u.sub,
    action: 'PROMPT_ROLLBACK',
    resource_type: 'prompt_version',
    resource_id: row.id,
    details: { from: previous, to: row.version },
    ip: ctx.ip,
  });
  ctx.body = { version: row.version, status: row.status };
});
