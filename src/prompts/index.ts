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

export interface ResolvedPrompt {
  /** 渲染好的系统提示词正文 */
  text: string;
  /** 实际生效的版本号 */
  version: string;
}

/**
 * 内置默认提示词。
 *
 * ⚠️ **这是兜底路径，不是主路径**：
 * 租户自带的提示词正文由 `src/services/prompt-registry.ts` 从 `prompt_versions` 表解析，
 * 通过 `buildPrompt` 的 `overrideContent` 传进来（那是 C3 的正常流程）。
 *
 * 走到这里说明**没拿到租户正文** —— 常见原因是配置指向的版本号在库里不存在
 * （版本被删了 / 配置写错了）。此时回落内置默认并 warn 一行，不报错：
 * 对终端用户来说「用默认提示词答错了」远好过「整轮对话 500」。
 *
 * ⚠️ 2026-10-25：**不再读 `tenants.settings`**。
 * 那个 JSON 列从来没有写入路径（迁移 013 已经把租户配置搬进 `tenant_settings` KV 表），
 * 读它永远拿到 null —— 留着只会让人以为「租户提示词版本走的是 settings 列」。
 */
export function resolvePrompt(tenantName: string): ResolvedPrompt {
  return {
    text: renderSystemPrompt(DEFAULT_SYSTEM_PROMPT, tenantName),
    version: DEFAULT_PROMPT_VERSION,
  };
}

export interface BuildPromptInput {
  /** 租户显示名，替换模板里的 {{tenantName}} */
  tenantName: string;
  /**
   * 租户自定义的提示词正文（docs/12-c §C3，在 prompt_versions 表里）。
   * 给了就用它 —— 正文已经由 src/services/prompt-registry.ts 解析好了，这里只负责拼资料段。
   */
  overrideContent?: string | null;
  /**
   * 会话早期内容的摘要段（B1 摘要压缩，见 src/services/session-summary.ts）。
   * 空串 / null = 这个会话还没有摘要。
   *
   * ⚠️ **拼在记忆段前面**：摘要和记忆的「权威度」都比资料段低 ——
   * 摘要是模型自动改写的（有损），记忆是用户/管理员背书的（更权威），
   * 资料是知识库原文（最权威）。位置越靠后模型越容易当成当下的依据，
   * 所以顺序反过来会让自动摘要压过公司制度。
   */
  summaryText?: string | null;
  /**
   * 用户长期记忆段（B4，见 src/services/memory.ts 的 renderMemoryBlock）。
   * 空串 / null = 这个用户还没有记忆。
   *
   * ⚠️ **拼在资料段前面**：记忆段自己写明了「与『可参考资料』冲突时以『可参考资料』为准」，
   * 而资料段在后面 —— 位置越靠后模型越容易当成当下的依据。顺序反过来会让记忆
   * 压过公司制度，那不是我们要的。
   */
  memoryText?: string | null;
  /** 已按相关度降序、且过了 token 预算裁剪的检索片段 */
  hits: Parameters<typeof renderRagContext>[0];
  /**
   * 可用工具段（B3 工具调用，见 shared/prompts/chat/tools.ts）。
   * 空串 / null = 这个租户没有启用任何工具。
   *
   * ⚠️ **单独注入，不能烤进基础提示词** —— 租户自定义提示词会整体替换 base，
   * 烤进去的话租户一改提示词工具就消失了，模型会以为没有工具可用。
   *
   * 位置在 base 之后、内容块（摘要 / 记忆 / 资料）之前：
   * 工具段是**能力声明**（不是证据），而三段内容块要保持在末尾连续 ——
   * 「位置越靠后模型越容易当成当下的依据」，摘要 / 记忆不能让它们跟资料段脱节。
   */
  toolsText?: string | null;
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
        }
      : resolvePrompt(input.tenantName);
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
    systemText: `${baseText}${input.toolsText ?? ''}${input.summaryText ?? ''}${input.memoryText ?? ''}${rag.text}`,
    rag,
    truncatedSystem,
  };
}

export { EMPTY_LIBRARY_NOTICE, NO_HITS_NOTICE };