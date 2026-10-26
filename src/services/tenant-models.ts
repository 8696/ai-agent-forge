import { Op } from 'sequelize';
import { getSequelize } from '../db';
import { TenantModel, type ModelUsageScope } from '../models';
import { NotFoundError, ValidationError } from '../lib/errors';
import { encryptSecret, decryptSecret, isSecretEncryptionEnabled, secretHint } from '../lib/crypto';
import { assertLlmEndpoint } from '../lib/llm-endpoint';
import { normalizeAnthropicBaseUrl } from '../config';
import { logger } from '../logger';

/**
 * 租户模型列表 —— docs/12-c §C4（模型选择）
 *
 * 一个租户可以配多个模型，逐条切换；对话走 `usage_scope='chat'` 且 `is_active` 的那条。
 *
 * **密钥铁律**：`api_key_enc` 是 AES-256-GCM 密文，永不回显；
 * 对外只有 `has_api_key` + `api_key_hint`（脱敏串）。
 *
 * ## 用途（usage_scope）
 *  - `chat`   对话模型
 *  - `memory` 记忆抽取模型（B4）。**没配就回落到对话模型**，行为跟没加这个字段之前一样。
 *
 * 不变式是「每租户**每个 scope** 恰一条 is_active」，不是「每租户恰一条」。
 */

export interface TenantModelView {
  id: string;
  name: string;
  provider: string | null;
  model_id: string;
  base_url: string;
  has_api_key: boolean;
  api_key_hint: string | null;
  temperature: number | null;
  max_output_tokens: number | null;
  prompt_cache_enabled: boolean;
  is_active: boolean;
  /** 用途：chat=对话模型 / memory=记忆抽取模型 */
  usage_scope: ModelUsageScope;
  /** 备用模型 id（C4）—— null = 没配 */
  fallback_model_id: string | null;
  updated_at: string;
}

export function toModelView(row: TenantModel): TenantModelView {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    model_id: row.model_id,
    base_url: row.base_url,
    has_api_key: row.api_key_enc !== null,
    api_key_hint: row.api_key_hint,
    // DECIMAL 列回来是字符串
    temperature: row.temperature === null ? null : Number(row.temperature),
    max_output_tokens: row.max_output_tokens,
    prompt_cache_enabled: row.prompt_cache_enabled,
    is_active: row.is_active,
    usage_scope: row.usage_scope,
    /** 备用模型 id（C4）—— null = 没配 */
    fallback_model_id: row.fallback_model_id ?? null,
    updated_at: row.updated_at.toISOString(),
  };
}

export async function listTenantModels(tenantId: string): Promise<TenantModelView[]> {
  const rows = await TenantModel.findAll({
    where: { tenant_id: tenantId },
    order: [['is_active', 'DESC'], ['created_at', 'DESC']],
  });
  return rows.map(toModelView);
}

export async function getTenantModel(tenantId: string, id: string): Promise<TenantModel> {
  const row = await TenantModel.findOne({ where: { id, tenant_id: tenantId } });
  if (row === null) {
    throw new NotFoundError('模型配置');
  }
  return row;
}

export interface UpsertModelInput {
  name: string;
  provider: string | null;
  model_id: string;
  base_url: string;
  /** 只写：undefined = 不改 / '' = 清掉（会拒绝，见下）/ 'xxx' = 换新 */
  api_key?: string | undefined;
  temperature: number | null;
  max_output_tokens: number | null;
  prompt_cache_enabled: boolean;
  /** 用途；不传 = chat（对话模型） */
  usage_scope?: ModelUsageScope | undefined;
  /**
   * 备用模型（指向同租户**同 scope**的另一条模型条目）。
   * undefined = 不改；null = 取消备用；'xxx' = 换新。
   */
  fallback_model_id?: string | null | undefined;
}

export async function createTenantModel(
  tenantId: string,
  userId: string,
  input: UpsertModelInput,
): Promise<TenantModel> {
  const normalized = await normalizeModelInput({
    base_url: input.base_url,
    model_id: input.model_id,
    api_key: input.api_key ?? '',
  });
  const scope: ModelUsageScope = input.usage_scope ?? 'chat';

  return getSequelize().transaction(async (t) => {
    // 这个 scope 的第一条模型自动成为该 scope 的启用项：否则租户建了模型却没选中，
    // 对话只会一直走 .env 默认，用户会以为「配了没生效」。
    //
    // ⚠️ 是**按 scope 各自计数**：租户先建了一条 chat 模型（自动启用），
    //    再建一条 memory 模型时，memory scope 还是空的 → 它也自动启用。
    const existingCount = await TenantModel.count({
      where: { tenant_id: tenantId, usage_scope: scope },
      transaction: t,
    });
    const created = await TenantModel.create(
      {
        tenant_id: tenantId,
        name: input.name,
        provider: input.provider,
        model_id: input.model_id,
        base_url: normalized.baseUrl,
        api_key_enc: normalized.encrypted.cipher,
        api_key_hint: normalized.encrypted.hint,
        temperature: input.temperature,
        max_output_tokens: input.max_output_tokens,
        prompt_cache_enabled: input.prompt_cache_enabled,
        usage_scope: scope,
        is_active: existingCount === 0,
        fallback_model_id: await normalizeFallbackId({
          tenantId,
          scope,
          selfId: null,
          fallbackId: input.fallback_model_id ?? null,
        }),
        updated_by: userId,
      },
      { transaction: t },
    );
    return created;
  });
}

export async function updateTenantModel(
  tenantId: string,
  id: string,
  userId: string,
  input: UpsertModelInput,
): Promise<TenantModel> {
  const row = await getTenantModel(tenantId, id);

  // ⚠️ **base_url 不管有没有重填 api_key 都要过 SSRF 闸门**。
  //
  // 「编辑时留空 API Key = 保持原样」是后台的**默认路径**
  // （docs/04-c §5.4.1 明写「编辑时留空 API Key = 保持原样，不重填也能改别的字段」）。
  // 之前这条路径走的是 `row.base_url = input.base_url` —— 不解析 DNS、
  // 不判私网 / 回环 / 云元数据、也不做 /v1 归一化，
  // 等于**绕开了新建时的闸门**：租户 admin 在生产环境能把端点指到
  // `169.254.169.254` 读云元数据，或指到内网打穿。
  const baseUrl = await normalizeBaseUrl(input.base_url);

  // api_key 不带 = 保持原样；带了才重新加密（编辑时不必重填密钥）
  const keepsExistingKey = input.api_key === undefined;
  const normalized = keepsExistingKey
    ? null
    : await normalizeModelInput({
        base_url: input.base_url,
        model_id: input.model_id,
        api_key: input.api_key ?? '',
        checkedBaseUrl: baseUrl,
      });

  row.name = input.name;
  row.provider = input.provider;
  row.model_id = input.model_id;
  row.base_url = baseUrl;
  row.temperature = input.temperature;
  row.max_output_tokens = input.max_output_tokens;
  row.prompt_cache_enabled = input.prompt_cache_enabled;
  if (input.fallback_model_id !== undefined) {
    row.fallback_model_id = await normalizeFallbackId({
      tenantId,
      scope: row.usage_scope,
      selfId: row.id,
      fallbackId: input.fallback_model_id,
    });
  }
  if (normalized !== null) {
    row.api_key_enc = normalized.encrypted.cipher;
    row.api_key_hint = normalized.encrypted.hint;
  }
  row.updated_by = userId;
  await row.save();

  // 改用途：这条模型换到另一个 scope 去了。
  //
  // ⚠️ 不能简单把 usage_scope 一改了事 —— 它原来可能在旧 scope 里是「启用中」，
  //    换过去就会变成「新 scope 里第二条启用项」，破坏不变式。
  //    所以：先把它在旧 scope 里的启用位去掉，再看新 scope 有没有启用项，
  //    没有就把它启用（有就不动，让管理员自己去切）。
  if (input.usage_scope !== undefined && input.usage_scope !== row.usage_scope) {
    row.usage_scope = input.usage_scope;
    row.is_active = false;
    await row.save();

    const activeInNewScope = await TenantModel.count({
      where: { tenant_id: tenantId, usage_scope: input.usage_scope, is_active: true },
    });
    if (activeInNewScope === 0) {
      await activateTenantModel(tenantId, row.id);
    }
  }

  return row;
}

/**
 * 启用某条模型：**同一个 scope 内**其它条目先全部置 false，再亮这条。
 * 在一个事务里做，保证「每租户每个 scope 恰一条 is_active」这个不变式。
 *
 * ⚠️ 跨 scope 不互斥：chat 和 memory 是两条独立的链路，各自一条启用项。
 */
export async function activateTenantModel(tenantId: string, id: string): Promise<TenantModel> {
  return getSequelize().transaction(async (t) => {
    const row = await TenantModel.findOne({
      where: { id, tenant_id: tenantId },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (row === null) {
      throw new NotFoundError('模型配置');
    }
    await TenantModel.update(
      { is_active: false },
      {
        where: {
          tenant_id: tenantId,
          usage_scope: row.usage_scope,
          is_active: true,
          id: { [Op.ne]: id },
        },
        transaction: t,
      },
    );
    row.is_active = true;
    await row.save({ transaction: t });
    return row;
  });
}

export async function deleteTenantModel(tenantId: string, id: string): Promise<void> {
  const row = await getTenantModel(tenantId, id);
  // 保护的是「删掉之后这条链路彻底没有租户自配的模型了」：
  //  - chat scope：对话会回落到平台默认（.env）—— 用户多半是误操作，拦一下
  //  - memory scope：抽取会回落到对话模型 —— 链路还在，允许删
  if (row.is_active && row.usage_scope === 'chat') {
    const activeCount = await TenantModel.count({
      where: { tenant_id: tenantId, usage_scope: 'chat' },
    });
    if (activeCount <= 1) {
      throw new ValidationError('这是唯一一条对话模型，删掉后对话会回落到平台默认');
    }
  }
  await row.destroy();
}

/** 对话链路拿到的「启用中的那条模型」—— 密钥已解密（失败时 degraded 有值） */
export interface ResolvedFallbackModel {
  id: string;
  name: string;
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number | null;
  maxOutputTokens: number | null;
  promptCacheEnabled: boolean;
}

export interface ResolvedActiveModel {
  id: string;
  name: string;
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number | null;
  maxOutputTokens: number | null;
  promptCacheEnabled: boolean;
  /** 密钥解不开等原因导致降级时写这里；null = 一切正常 */
  degraded: string | null;
  /** 备用模型；null = 没配（主模型失败就直接报错） */
  fallback: ResolvedFallbackModel | null;
}

/**
 * 取某个 scope 下启用中的那条模型 —— 密钥已解密（失败时 degraded 有值）。
 * 没有启用模型 → 返回 null，由调用方回落（对话回落 .env 进程默认，
 * 记忆抽取回落到对话模型）。
 */
export async function resolveActiveModel(
  tenantId: string,
  scope: ModelUsageScope = 'chat',
): Promise<ResolvedActiveModel | null> {
  const row = await TenantModel.findOne({
    where: { tenant_id: tenantId, usage_scope: scope, is_active: true },
  });
  if (row === null) {
    return null;
  }

  // 密钥解不开时**不抛**：整条模型标记为不可用，调用方回落平台默认凭据。
  // 抛出去的话，密钥轮换期间整个租户的对话会全挂。
  let apiKey = '';
  let degraded: string | null = null;
  try {
    apiKey = decryptSecret(row.api_key_enc);
  } catch (err: unknown) {
    degraded = `模型 apiKey 解密失败（${err instanceof Error ? err.message : String(err)}），已回落到平台默认凭据`;
    logger.error({ err, tenantId, modelId: row.id }, '租户模型密钥不可用');
  }

  return {
    id: row.id,
    name: row.name,
    provider: row.provider ?? 'custom',
    apiKey,
    baseUrl: row.base_url,
    model: row.model_id,
    temperature: row.temperature === null ? null : Number(row.temperature),
    maxOutputTokens: row.max_output_tokens,
    promptCacheEnabled: row.prompt_cache_enabled,
    degraded,
    fallback: await resolveFallbackModel(tenantId, scope, row.fallback_model_id),
  };
}

/**
 * 解析备用模型 —— 主模型失败时顶上来的那条。
 *
 * ⚠️ **备用模型的密钥解不开时当没有备用**（返回 null）——
 *    主模型还能正常用，没必要因为备用不可用就拖垮整轮。
 * ⚠️ 备用必须是**同租户、同 scope** 的另一条（配的时候已经校验过，
 *    这里再查一次是防「配完之后那条模型被删了 / 改了 scope」）。
 */
async function resolveFallbackModel(
  tenantId: string,
  scope: ModelUsageScope,
  fallbackId: string | null,
): Promise<ResolvedFallbackModel | null> {
  if (fallbackId === null || fallbackId === '') {
    return null;
  }
  const row = await TenantModel.findOne({
    where: { id: fallbackId, tenant_id: tenantId, usage_scope: scope },
  });
  if (row === null) {
    logger.warn({ tenantId, scope, fallbackId }, '备用模型不存在或已改用途，按没有备用处理');
    return null;
  }
  try {
    return {
      id: row.id,
      name: row.name,
      provider: row.provider ?? 'custom',
      apiKey: decryptSecret(row.api_key_enc),
      baseUrl: row.base_url,
      model: row.model_id,
      temperature: row.temperature === null ? null : Number(row.temperature),
      maxOutputTokens: row.max_output_tokens,
      promptCacheEnabled: row.prompt_cache_enabled,
    };
  } catch (err: unknown) {
    logger.error({ err, tenantId, modelId: row.id }, '备用模型密钥不可用，按没有备用处理');
    return null;
  }
}

/**
 * 校验「备用模型」指向的条目 —— 必须是**同租户、同 scope**的另一条。
 *
 * ⚠️ 跨租户 / 跨用途都拒绝：chat 的备用不能是 memory 的
 *    （用途不同、成本也不同 —— 拿抽取用的便宜模型顶对话是事故）。
 */
async function normalizeFallbackId(params: {
  tenantId: string;
  scope: ModelUsageScope;
  selfId: string | null;
  fallbackId: string | null;
}): Promise<string | null> {
  const id = params.fallbackId;
  if (id === null || id === '') {
    return null;
  }
  if (params.selfId !== null && id === params.selfId) {
    throw new ValidationError('备用模型不能是它自己');
  }
  const row = await TenantModel.findOne({
    where: { id, tenant_id: params.tenantId, usage_scope: params.scope },
    attributes: ['id'],
  });
  if (row === null) {
    throw new ValidationError('备用模型必须是本租户、同一用途下的另一条模型');
  }
  return id;
}

// ============================================================
// 输入校验
// ============================================================

/**
 * base_url 的校验 + 归一化 —— **新建和编辑共用**。
 *
 * SSRF 闸门在这里（src/lib/llm-endpoint.ts）：生产默认拦内网 / 回环 / 云元数据地址。
 * 单独抽出来是因为「编辑模型」这条路径也需要它 —— 见 updateTenantModel 的注释。
 */
export async function normalizeBaseUrl(rawBaseUrl: string): Promise<string> {
  await assertLlmEndpoint(rawBaseUrl);
  return normalizeAnthropicBaseUrl(rawBaseUrl);
}

/**
 * 校验并规范化新模型的连接参数。
 * 独立成函数是为了让「新建」和「编辑」共用同一套校验 —— 少一处规则就少一处漏网。
 */
export async function normalizeModelInput(input: {
  base_url: string;
  model_id: string;
  api_key: string | null;
  /**
   * 已经过 SSRF 校验 + 归一化的 base_url。
   * 编辑路径会先自己校验一次再传进来 —— 复用结果，避免重复解析 DNS。
   */
  checkedBaseUrl?: string | undefined;
}): Promise<{ baseUrl: string; encrypted: { cipher: Buffer; hint: string } }> {
  if (input.model_id.trim() === '') {
    throw new ValidationError('模型 id 不能为空');
  }
  // SSRF 校验：生产默认拦内网 / 云元数据地址（src/lib/llm-endpoint.ts）
  const baseUrl = input.checkedBaseUrl ?? (await normalizeBaseUrl(input.base_url));
  const key = input.api_key;
  if (key === null || key.trim() === '') {
    throw new ValidationError('API Key 不能为空');
  }
  if (!isSecretEncryptionEnabled()) {
    throw new ValidationError(
      '服务端未配置 CONFIG_ENCRYPTION_KEY，出于安全考虑不支持保存 API Key。请先让平台管理员配置。',
    );
  }
  const trimmed = key.trim();
  return {
    baseUrl,
    encrypted: { cipher: encryptSecret(trimmed), hint: secretHint(trimmed) },
  };
}
