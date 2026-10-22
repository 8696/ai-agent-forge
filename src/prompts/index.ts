import {
  DEFAULT_PROMPT_VERSION,
  DEFAULT_SYSTEM_PROMPT,
  EMPTY_LIBRARY_NOTICE,
  NO_HITS_NOTICE,
  renderSystemPrompt,
} from '@shared/prompts/chat/system-default';
import { renderRagContext, type RagContextResult } from '@shared/prompts/chat/rag-context';
import { logger } from '../logger';
import { estimateTokens } from '../lib/token-estimate';

/**
 * 提示词拼装层 —— B1（docs/12-b §B1）、提示词工程见 docs/07-a-模块-llm与prompt.md 模块 03
 *
 * 分工：
 *   shared/prompts/chat/*  纯常量 + 纯函数（提示词正文、资料段模板与编号规则）
 *   src/prompts/index.ts   ← 本文件：读租户设置、做长度兜底、把两层拼起来
 *
 * 只在这里 import 后端专有的东西（logger / token 估算），shared/ 那边保持零依赖。
 */

/** 租户 settings 里可覆盖的字段（与 src/models/Tenant.ts 的 TenantSettings 对齐） */
export interface PromptOverrides {
  /** 提示词版本号；本期只认默认版本，其他值静默回落 */
  prompt_version?: string;
  [key: string]: unknown;
}

export interface ResolvedPrompt {
  /** 渲染好的系统提示词正文 */
  text: string;
  /** 实际生效的版本号 */
  version: string;
  /** 是否发生了回落（认不出的版本号）—— 调用方可记日志 */
  fellBack: boolean;
}

/**
 * 按租户设置挑提示词。
 *
 * 租户级**真实**覆盖（自带提示词正文）是 C3 的需求，本期不实现：
 * 这里只把读取口子留好，认不出的版本号 warn 一下回落默认值 —— 不报错，
 * 因为对终端用户来说「用默认提示词答错了」远好过「整轮对话 500」。
 */
export function resolvePrompt(
  tenantName: string,
  settings: PromptOverrides | null,
): ResolvedPrompt {
  const requested = settings?.prompt_version;
  if (requested === undefined || requested === DEFAULT_PROMPT_VERSION) {
    return {
      text: renderSystemPrompt(DEFAULT_SYSTEM_PROMPT, tenantName),
      version: DEFAULT_PROMPT_VERSION,
      fellBack: false,
    };
  }

  logger.warn(
    { tenantName, requested },
    '租户指定的提示词版本不存在（提示词仓库属 C3，本期未实现），回落默认版本',
  );
  return {
    text: renderSystemPrompt(DEFAULT_SYSTEM_PROMPT, tenantName),
    version: DEFAULT_PROMPT_VERSION,
    fellBack: true,
  };
}

export interface BuildPromptInput {
  /** 租户显示名，替换模板里的 {{tenantName}} */
  tenantName: string;
  /** 租户级设置（可为空） */
  settings: PromptOverrides | null;
  /**
   * 租户自定义的提示词正文（docs/12-c §C3，在 prompt_versions 表里）。
   * 给了就用它、忽略 settings.prompt_version —— 正文已经由
   * src/services/prompt-registry.ts 解析好了，这里只负责拼资料段。
   */
  overrideContent?: string | null;
  /** 已按相关度降序、且过了 token 预算裁剪的检索片段 */
  hits: Parameters<typeof renderRagContext>[0];
  /** 检索为空时的降级文案（区分「库是空的」和「没命中」） */
  emptyNotice?: string;
  /** 系统提示词的 token 上限；超了硬截断并 warn */
  systemTokenBudget: number;
}

export interface BuiltPrompt extends ResolvedPrompt {
  /** 完整系统提示词（= 模板 + 资料段），可直接喂 streamText 的 system */
  systemText: string;
  /** 资料段部分（与发给前端的 data-citations 同编号） */
  rag: RagContextResult;
  /** 系统提示词是否被截断过 */
  truncatedSystem: boolean;
}

/**
 * 组装完整的系统提示词 = 基础提示词 + 检索资料段。
 *
 * 资料段编号和 data-citations 的 index 出自同一个 renderRagContext()，
 * 所以模型写的 `[3]` 和前端角标显示的第 3 条一定对得上。
 */
export function buildPrompt(input: BuildPromptInput): BuiltPrompt {
  const override = input.overrideContent;
  const base =
    override !== null && override !== undefined && override.trim() !== ''
      ? {
          text: renderSystemPrompt(override, input.tenantName),
          version: 'tenant',
          fellBack: false,
        }
      : resolvePrompt(input.tenantName, input.settings);
  const rag = renderRagContext(input.hits, input.emptyNotice ?? NO_HITS_NOTICE);

  let baseText = base.text;
  let truncatedSystem = false;
  // 默认提示词约 330 token、预算 600，正常不会走到这。
  // 走到了说明租户自定义了超长提示词，硬截断总比撞 provider 的 400 好。
  if (estimateTokens(baseText) > input.systemTokenBudget) {
    truncatedSystem = true;
    baseText = baseText.slice(0, Math.max(0, Math.floor(baseText.length * 0.8)));
    logger.warn(
      { tenantName: input.tenantName, budget: input.systemTokenBudget },
      '系统提示词超出 token 预算，已硬截断',
    );
  }

  return {
    ...base,
    systemText: `${baseText}${rag.text}`,
    rag,
    truncatedSystem,
  };
}

export { EMPTY_LIBRARY_NOTICE, NO_HITS_NOTICE };