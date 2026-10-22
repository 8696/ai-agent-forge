import { Op } from 'sequelize';
import { getSequelize } from '../db';
import { PromptVersion, type PromptVersionStatus } from '../models';
import { NotFoundError, ValidationError } from '../lib/errors';
import { logger } from '../logger';
import {
  DEFAULT_PROMPT_VERSION,
  DEFAULT_SYSTEM_PROMPT,
  renderSystemPrompt,
} from '@shared/prompts/chat/system-default';

/**
 * 租户提示词解析 —— docs/12-c §C3（提示词配置）
 *
 * 优先级：
 *   tenant_llm_configs.prompt_version → prompt_versions 里那条 production 的正文
 *   → 都没配 / 版本找不到 → shared/prompts/chat/system-default.ts 的内置默认
 *
 * **每轮对话都读库**（docs/12-e §E2 验收「改完不重启立即生效」），
 * 不走进程缓存 —— 一次对话本来就要好几次 DB / 网络 IO，多这一次可忽略。
 */

export interface ResolvedTenantPrompt {
  /** 渲染后的提示词正文（已替换 {{tenantName}}） */
  text: string;
  /** 生效的版本号；用了内置默认时是 'chat-v1' */
  version: string;
  /** 正文来源：租户自定义 vs 内置默认 */
  origin: 'tenant' | 'builtin';
  /** 从库里的提示词版本 id（回滚 / 审计用） */
  promptVersionId: string | null;
}

export function builtinPrompt(tenantName: string): ResolvedTenantPrompt {
  return {
    text: renderSystemPrompt(DEFAULT_SYSTEM_PROMPT, tenantName),
    version: DEFAULT_PROMPT_VERSION,
    origin: 'builtin',
    promptVersionId: null,
  };
}

/**
 * 解析某租户当前生效的提示词。
 *
 * @param promptVersion 租户配置里指定的版本号；null/undefined = 没配，用内置默认
 * @param tenantName    替换正文里的 {{tenantName}}
 */
export async function resolveTenantPrompt(
  tenantId: string,
  promptVersion: string | null | undefined,
  tenantName: string,
): Promise<ResolvedTenantPrompt> {
  if (promptVersion === null || promptVersion === undefined || promptVersion === '') {
    return builtinPrompt(tenantName);
  }
  // 指向内置默认（比如手工填了 chat-v1）也算合法
  if (promptVersion === DEFAULT_PROMPT_VERSION) {
    return builtinPrompt(tenantName);
  }

  const row = await PromptVersion.findOne({
    where: { tenant_id: tenantId, version: promptVersion },
  });
  if (row === null) {
    // 版本被删了但配置还指着它 —— 回落默认 + 一行 warn。
    // 不抛错：对终端用户来说「用默认提示词答错了」远好过「整轮对话 500」
    logger.warn({ tenantId, promptVersion }, '配置的提示词版本不存在，回落内置默认');
    return builtinPrompt(tenantName);
  }
  return {
    text: renderSystemPrompt(row.content, tenantName),
    version: row.version,
    origin: 'tenant',
    promptVersionId: row.id,
  };
}

// ============================================================
// 版本管理（后台 /admin/model/prompt 用）
// ============================================================

export interface PromptVersionListItem {
  id: string;
  version: string;
  status: PromptVersionStatus;
  description: string | null;
  deployed_at: string | null;
  updated_at: string;
  /** 是否正在被 tenant_llm_configs.prompt_version 引用 */
  in_use: boolean;
}

export async function listPromptVersions(
  tenantId: string,
  activeVersion: string | null,
): Promise<PromptVersionListItem[]> {
  const rows = await PromptVersion.findAll({
    where: { tenant_id: tenantId },
    order: [['created_at', 'DESC']],
  });
  return rows.map((r) => ({
    id: r.id,
    version: r.version,
    status: r.status,
    description: r.description,
    deployed_at: r.deployed_at?.toISOString() ?? null,
    updated_at: r.updated_at.toISOString(),
    in_use: r.version === activeVersion,
  }));
}

const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$/;

export async function createPromptVersion(params: {
  tenantId: string;
  userId: string;
  version: string;
  content: string;
  description?: string | undefined;
}): Promise<PromptVersion> {
  if (!VERSION_PATTERN.test(params.version)) {
    throw new ValidationError('版本号只能用字母数字和 - _，长度 1~20');
  }
  if (params.content.trim() === '') {
    throw new ValidationError('提示词内容不能为空');
  }
  const exists = await PromptVersion.findOne({
    where: { tenant_id: params.tenantId, version: params.version },
  });
  if (exists !== null) {
    throw new ValidationError(`版本 ${params.version} 已存在`);
  }
  return PromptVersion.create({
    tenant_id: params.tenantId,
    version: params.version,
    content: params.content,
    description: params.description ?? null,
    status: 'draft',
    created_by: params.userId,
  });
}

/**
 * 保存草稿。**只允许改 draft** ——
 * production 已经被真实用户用过了，静默改它等于让线上行为无预告地漂移，
 * 必须走「复制成新 draft → 发布」这条路。
 */
export async function updatePromptDraft(params: {
  tenantId: string;
  version: string;
  content: string;
  description?: string | undefined;
}): Promise<PromptVersion> {
  const row = await PromptVersion.findOne({
    where: { tenant_id: params.tenantId, version: params.version },
  });
  if (row === null) {
    throw new NotFoundError('提示词版本');
  }
  if (row.status !== 'draft') {
    throw new ValidationError(
      `版本 ${row.version} 是「${row.status}」，不能直接改。请复制成新草稿再发布。`,
    );
  }
  if (params.content.trim() === '') {
    throw new ValidationError('提示词内容不能为空');
  }
  row.content = params.content;
  if (params.description !== undefined) {
    row.description = params.description;
  }
  await row.save();
  return row;
}

/**
 * 发布：把某版本置为 production，同租户其他 production 转 archived。
 *
 * 单租户同时只有一个 production —— 这条不变式由这里的「先全部 archived，
 * 再置新的 production」保证（两步之间靠事务串起来）。
 */
export async function publishPromptVersion(params: {
  tenantId: string;
  version: string;
  userId: string;
}): Promise<PromptVersion> {
  const sequelize = getSequelize();
  return sequelize.transaction(async (t) => {
    const row = await PromptVersion.findOne({
      where: { tenant_id: params.tenantId, version: params.version },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (row === null) {
      throw new NotFoundError('提示词版本');
    }
    await PromptVersion.update(
      { status: 'archived' },
      {
        where: { tenant_id: params.tenantId, status: 'production', id: { [Op.ne]: row.id } },
        transaction: t,
      },
    );
    row.status = 'production';
    row.deployed_at = new Date();
    row.deployed_by = params.userId;
    await row.save({ transaction: t });
    return row;
  });
}

export async function deletePromptVersion(tenantId: string, version: string): Promise<void> {
  const row = await PromptVersion.findOne({
    where: { tenant_id: tenantId, version },
  });
  if (row === null) {
    throw new NotFoundError('提示词版本');
  }
  if (row.status === 'production') {
    throw new ValidationError('生产中的版本不能删，先把别的版本发布上去');
  }
  await row.destroy();
}