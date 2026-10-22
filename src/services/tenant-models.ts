import { Op } from 'sequelize';
import { getSequelize } from '../db';
import { TenantModel } from '../models';
import { NotFoundError, ValidationError } from '../lib/errors';
import { encryptSecret, decryptSecret, isSecretEncryptionEnabled, secretHint } from '../lib/crypto';
import { assertLlmEndpoint } from '../lib/llm-endpoint';
import { normalizeAnthropicBaseUrl } from '../config';
import { logger } from '../logger';

/**
 * 租户模型列表 —— docs/12-c §C4（模型选择）
 *
 * 一个租户可以配多个模型，逐条切换；对话走 `is_active` 的那条。
 *
 * **密钥铁律**：`api_key_enc` 是 AES-256-GCM 密文，永不回显；
 * 对外只有 `has_api_key` + `api_key_hint`（脱敏串）。
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

  return getSequelize().transaction(async (t) => {
    // 第一条模型自动成为启用项：否则租户建了模型却没选中，
    // 对话只会一直走 .env 默认，用户会以为「配了没生效」
    const existingCount = await TenantModel.count({ where: { tenant_id: tenantId }, transaction: t });
    const created = await TenantModel.create(
      {
        tenant_id: tenantId,
        name: input.name,
        provider: input.provider,
        model_id: normalized.baseUrl === input.base_url ? input.model_id : input.model_id,
        base_url: normalized.baseUrl,
        api_key_enc: normalized.encrypted.cipher,
        api_key_hint: normalized.encrypted.hint,
        temperature: input.temperature,
        max_output_tokens: input.max_output_tokens,
        prompt_cache_enabled: input.prompt_cache_enabled,
        is_active: existingCount === 0,
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

  // api_key 不带 = 保持原样；带了才重新校验（编辑时不必重填密钥）
  const keepsExistingKey = input.api_key === undefined;
  const normalized = keepsExistingKey
    ? null
    : await normalizeModelInput({
        base_url: input.base_url,
        model_id: input.model_id,
        api_key: input.api_key ?? '',
      });

  row.name = input.name;
  row.provider = input.provider;
  row.model_id = input.model_id;
  row.base_url = normalized?.baseUrl ?? input.base_url;
  row.temperature = input.temperature;
  row.max_output_tokens = input.max_output_tokens;
  row.prompt_cache_enabled = input.prompt_cache_enabled;
  if (normalized !== null) {
    row.api_key_enc = normalized.encrypted.cipher;
    row.api_key_hint = normalized.encrypted.hint;
  }
  row.updated_by = userId;
  await row.save();
  return row;
}

/**
 * 启用某条模型：同一租户其它条目先全部置 false，再亮这条。
 * 在一个事务里做，保证「每租户恰一条 is_active」这个不变式。
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
      { where: { tenant_id: tenantId, is_active: true, id: { [Op.ne]: id } }, transaction: t },
    );
    row.is_active = true;
    await row.save({ transaction: t });
    return row;
  });
}

export async function deleteTenantModel(tenantId: string, id: string): Promise<void> {
  const row = await getTenantModel(tenantId, id);
  const activeCount = await TenantModel.count({ where: { tenant_id: tenantId } });
  if (row.is_active && activeCount <= 1) {
    throw new ValidationError('这是唯一一条模型配置，删掉后对话会回落到平台默认');
  }
  await row.destroy();
}

/** 对话链路拿到的「启用中的那条模型」—— 密钥已解密（失败时 degraded 有值） */
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
}

/**
 * 对话链路取「启用中的那条」，解密出可用凭据。
 * 没有启用模型 → 返回 null，由调用方回落 .env 进程默认。
 */
export async function resolveActiveModel(tenantId: string): Promise<ResolvedActiveModel | null> {
  const row = await TenantModel.findOne({ where: { tenant_id: tenantId, is_active: true } });
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
  };
}

// ============================================================
// 输入校验
// ============================================================

/**
 * 校验并规范化新模型的连接参数。
 * 独立成函数是为了让「新建」和「编辑」共用同一套校验 —— 少一处规则就少一处漏网。
 */
export async function normalizeModelInput(input: {
  base_url: string;
  model_id: string;
  api_key: string | null;
}): Promise<{ baseUrl: string; encrypted: { cipher: Buffer; hint: string } }> {
  if (input.model_id.trim() === '') {
    throw new ValidationError('模型 id 不能为空');
  }
  // SSRF 校验：生产默认拦内网 / 云元数据地址（src/lib/llm-endpoint.ts）
  await assertLlmEndpoint(input.base_url);
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
    baseUrl: normalizeAnthropicBaseUrl(input.base_url),
    encrypted: { cipher: encryptSecret(trimmed), hint: secretHint(trimmed) },
  };
}
