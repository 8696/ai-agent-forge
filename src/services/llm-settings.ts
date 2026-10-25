import { config, getLlm, type ProviderConfig } from '../config';
import { logger } from '../logger';
import { resolveActiveModel } from './tenant-models';
import { getSettingValues } from './tenant-settings';

/**
 * 对话链路的**唯一**取配置入口 —— docs/12-c §C4（模型选择）+ docs/12-e §E2（租户级配置）
 *
 * 数据来自三处，**逐项回落**：
 *   1. 启用中的模型条目（tenant_models，is_active）—— 端点 / 密钥 / 模型 / 采样
 *   2. 通用配置 KV（tenant_settings）—— 检索条数 / 历史轮数等对话参数
 *   3. .env 进程级默认（config.CHAT / resolveLlm）
 *
 * 每轮对话调一次，所以后台保存后**立即生效**（docs/12-e §E2 验收），不用重启。
 * 这是刻意的取舍：一次对话本来就要好几次 DB / 网络 IO，多这一次可忽略。
 */

/** 解析后的、可直接喂给 createAnthropic() 的配置 */
export interface ResolvedLlmSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** 展示用 provider 标识（日志 / 审计） */
  provider: string;
  temperature: number;
  maxOutputTokens: number;
  /** 检索召回的候选块数 */
  retrievalTopK: number;
  /** 最多带多少轮历史进提示词 */
  maxHistoryTurns: number;
  /** 知识库片段能占的 token 上限 */
  retrievalTokenBudget: number;
  /** system + 历史 + 检索片段的总 token 预算 */
  contextTokenBudget: number;
  /** 会话摘要段能占的 token 上限（B1 摘要压缩） */
  summaryTokenBudget: number;
  /** 租户要不要开会话摘要（B1 摘要压缩）—— 关掉就只剩「丢弃更早的轮次」 */
  summaryEnabled: boolean;
  /** 单条用户消息的字数上限 */
  maxInputChars: number;
  /** 思考模式推理预算；0 = 关 */
  thinkingBudgetTokens: number;
  /** 本租户要不要开重排序（B2 · docs/12-c §C4 的 rerank_enabled） */
  rerankEnabled: boolean;
  /** 本租户要不要开查询改写（B2 · 可选功能，每轮多一次模型调用） */
  queryRewriteEnabled: boolean;
  /** 是否给系统提示词打 cacheControl */
  promptCacheEnabled: boolean;
  /** 生效的提示词版本号（null = 内置默认） */
  promptVersion: string | null;
  /** 用了哪条模型条目（null = 走 .env 进程默认） */
  modelEntryId: string | null;
  /** 这一轮的配置来自哪一层 —— 日志里要能看出来 */
  source: 'tenant-model' | 'process-default';
  /** 配置有问题但已降级时写在这里，调用方据此告警 */
  degraded: string | null;
}

/**
 * 模型层的一份配置（密钥已解密成明文）。
 * 解密放在 resolveActiveModel 里做，那儿才有「解不开就降级」的上下文。
 */
export interface RawModelLayer {
  provider: string | null;
  model_id: string;
  base_url: string;
  apiKey: string;
  temperature: number | null;
  max_output_tokens: number | null;
  prompt_cache_enabled: boolean;
}

export type RawSettings = Record<string, number | boolean | string | null>;

export interface ProcessDefaults {
  llm: Pick<ProviderConfig, 'llmApiKey' | 'llmBaseUrl' | 'llmModel' | 'provider'>;
  temperature: number;
  maxOutputTokens: number;
  retrievalTopK: number;
  maxHistoryTurns: number;
  retrievalTokenBudget: number;
  contextTokenBudget: number;
  summaryTokenBudget: number;
  summaryEnabled: boolean;
  maxInputChars: number;
  thinkingBudgetTokens: number;
  promptCacheEnabled: boolean;
  rerankEnabled: boolean;
}

/**
 * 合并三层配置 —— 纯函数，单测直接喂假数据覆盖优先级。
 *
 * @param degraded 模型密钥解密失败的原因；由调用方（resolveLlmSettings）传入，
 *                 这里只负责透传到返回值
 */
export function mergeSettings(
  model: RawModelLayer | null,
  settings: RawSettings,
  defaults: ProcessDefaults,
  degraded: string | null = null,
): ResolvedLlmSettings {
  // KV 值对所有路径都生效 —— 租户没配模型条目时也照样能用。
  // 取值一律走「类型对得上才用」，否则回落 .env 默认：
  // 手滑存进来的坏值不该让整个对话崩掉（tenant-settings 那边也会 warn）。
  const num = (key: string, fallback: number): number => {
    const v = settings[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  };
  const bool = (key: string, fallback: boolean): boolean => {
    const v = settings[key];
    return typeof v === 'boolean' ? v : fallback;
  };
  const promptVersion = settings['prompt_version'];

  const kvOverlay = {
    promptVersion: typeof promptVersion === 'string' ? promptVersion : null,
    retrievalTopK: num('retrieval_top_k', defaults.retrievalTopK),
    maxHistoryTurns: num('max_history_turns', defaults.maxHistoryTurns),
    retrievalTokenBudget: num('retrieval_token_budget', defaults.retrievalTokenBudget),
    contextTokenBudget: num('context_token_budget', defaults.contextTokenBudget),
    summaryTokenBudget: num('summary_token_budget', defaults.summaryTokenBudget),
    // 平台总开关关掉时，租户配的「开」也无效 —— 平台级是硬边界
    summaryEnabled: defaults.summaryEnabled && bool('summary_enabled', true),
    maxInputChars: num('max_input_chars', defaults.maxInputChars),
    thinkingBudgetTokens: num('thinking_budget_tokens', defaults.thinkingBudgetTokens),
    // 平台总开关关掉时，租户配的「开」也无效 —— 平台级是硬边界
    rerankEnabled: defaults.rerankEnabled && bool('rerank_enabled', true),
    // 查询改写：纯租户级开关（平台没有总开关）
    queryRewriteEnabled: bool('query_rewrite_enabled', false),
  };

  if (model === null) {
    return {
      apiKey: defaults.llm.llmApiKey,
      baseUrl: defaults.llm.llmBaseUrl,
      model: defaults.llm.llmModel,
      provider: defaults.llm.provider,
      temperature: defaults.temperature,
      maxOutputTokens: defaults.maxOutputTokens,
      promptCacheEnabled: defaults.promptCacheEnabled,
      modelEntryId: null,
      source: 'process-default',
      degraded,
      ...kvOverlay,
    };
  }

  return {
    apiKey: model.apiKey,
    // base_url 存的时候已 normalize 过（见 normalizeModelInput），这里不再拼 /v1
    baseUrl: model.base_url,
    model: model.model_id,
    provider: model.provider ?? defaults.llm.provider,
    temperature: model.temperature ?? defaults.temperature,
    maxOutputTokens: model.max_output_tokens ?? defaults.maxOutputTokens,
    promptCacheEnabled: model.prompt_cache_enabled,
    modelEntryId: null,
    source: 'tenant-model',
    degraded,
    ...kvOverlay,
  };
}

/** 对话每轮调这个：读「启用中的模型 + KV」，合成为一份配置 */
export async function resolveLlmSettings(tenantId: string): Promise<ResolvedLlmSettings> {
  const cfg = getLlm();
  const defaults: ProcessDefaults = {
    llm: {
      llmApiKey: cfg.llmApiKey,
      llmBaseUrl: cfg.llmBaseUrl,
      llmModel: cfg.llmModel,
      provider: cfg.provider,
    },
    temperature: config.CHAT.TEMPERATURE,
    maxOutputTokens: config.CHAT.MAX_OUTPUT_TOKENS,
    retrievalTopK: config.CHAT.RETRIEVAL_TOP_K,
    maxHistoryTurns: config.CHAT.MAX_HISTORY_TURNS,
    retrievalTokenBudget: config.CHAT.RETRIEVAL_TOKEN_BUDGET,
    contextTokenBudget: config.CHAT.CONTEXT_TOKEN_BUDGET,
    summaryTokenBudget: config.CHAT.SUMMARY_TOKEN_BUDGET,
    summaryEnabled: config.CHAT.SUMMARY_ENABLED,
    maxInputChars: config.CHAT.MAX_INPUT_CHARS,
    thinkingBudgetTokens: config.CHAT.THINKING_BUDGET_TOKENS,
    // 提示词缓存默认开（docs/04-c §5.4.1）
    promptCacheEnabled: true,
    // 重排默认开（平台级）；平台没配重排服务时下游会自动跳过
    rerankEnabled: config.RERANK.ENABLED,
  };

  let active: Awaited<ReturnType<typeof resolveActiveModel>> = null;
  let settings: RawSettings = {};
  try {
    [active, settings] = await Promise.all([
      resolveActiveModel(tenantId),
      getSettingValues(tenantId, [
        'retrieval_top_k',
        'max_history_turns',
        'retrieval_token_budget',
        'context_token_budget',
        'summary_token_budget',
        'summary_enabled',
        'max_input_chars',
        'thinking_budget_tokens',
        'rerank_enabled',
        'query_rewrite_enabled',
        'prompt_version',
      ]),
    ]);
  } catch (err: unknown) {
    // 表还没建（老库没跑 013 迁移）不该让整个对话挂掉
    logger.warn(
      { tenantId, err: err instanceof Error ? err.message : String(err) },
      '读租户配置失败，按进程默认走',
    );
  }

  const modelLayer: RawModelLayer | null =
    active === null || active.degraded !== null
      ? null
      : {
          provider: active.provider,
          model_id: active.model,
          base_url: active.baseUrl,
          apiKey: active.apiKey,
          temperature: active.temperature,
          max_output_tokens: active.maxOutputTokens,
          prompt_cache_enabled: active.promptCacheEnabled,
        };

  return mergeSettings(modelLayer, settings, defaults, active?.degraded ?? null);
}

/**
 * 后台「当前生效」的概览 —— 给 /admin/models 页面顶部用。
 * 只读不写，`.env` 没配全也降级成 unknown 而不是抛错（后台要能正常打开）。
 */
export function describeProcessLlmDefaults(): {
  provider: string;
  llmModel: string;
  baseUrlConfigured: boolean;
} {
  try {
    const cfg = getLlm();
    return { provider: cfg.provider, llmModel: cfg.llmModel, baseUrlConfigured: true };
  } catch {
    return { provider: 'unknown', llmModel: '', baseUrlConfigured: false };
  }
}

// ============================================================
// 旁路 LLM 调用的模型解析（记忆抽取 / 会话摘要）
// ============================================================

/**
 * 旁路模型解析结果。
 *
 * `source` 说明这次调用实际用了哪一层 —— 旁路调用是**独立的一次 LLM 调用**，
 * 一次实测 2000 token 量级，成本必须能追溯到具体是哪条模型配置。
 */
export interface ResolvedScopedLlm {
  apiKey: string;
  baseUrl: string;
  model: string;
  provider: string;
  /**
   * - `tenant-model`  租户单独配了这条用途的模型条目（usage_scope='memory' / 'summary'）
   * - `chat-model`    没配专用模型 → 回落到对话模型
   * - `process-default` 租户一条模型都没配 → 回落到 .env 平台默认
   */
  source: 'tenant-model' | 'chat-model' | 'process-default';
  /** 用了哪条模型条目（null = 走 .env 进程默认） */
  modelEntryId: string | null;
  /** 配置有问题但已降级时写在这里，调用方据此告警 */
  degraded: string | null;
}

/**
 * 解析旁路调用该用哪个模型。
 *
 * ## 为什么能独立配置
 * 旁路调用的产物是结构化文本，推理型模型的思考 token 全额算输出 token ——
 * 用对话那个模型，一次实测 2000+ token，而租户没有任何办法把它切便宜。
 * 租户在 `/admin/models` 里加一条对应 usage_scope 的模型条目就能解决。
 *
 * ## 回落链
 * 专用模型 → 对话模型 → .env 平台默认。
 * 没配专用模型的租户**行为完全不变**（还是用对话模型跑）。
 *
 * ## 温度固定 0
 * 旁路调用的产物要被程序解析，模型一乱来就整轮丢掉（解析失败 = 白花一次调用）。
 * 条目里配的 temperature 是给对话用的，不套用到旁路。
 */
export async function resolveScopedLlm(
  tenantId: string,
  scope: 'memory' | 'summary',
): Promise<ResolvedScopedLlm> {
  let degraded: string | null = null;

  // 1) 租户单独配的专用模型
  const scopedModel = await resolveActiveModel(tenantId, scope);
  if (scopedModel !== null) {
    if (scopedModel.degraded === null) {
      return {
        apiKey: scopedModel.apiKey,
        baseUrl: scopedModel.baseUrl,
        model: scopedModel.model,
        provider: scopedModel.provider,
        source: 'tenant-model',
        modelEntryId: scopedModel.id,
        degraded: null,
      };
    }
    // 密钥解不开 → 记下来，回落到对话模型（别让整个旁路调用停摆）
    degraded = scopedModel.degraded;
  }

  // 2) 回落到对话模型
  const chatModel = await resolveActiveModel(tenantId, 'chat');
  if (chatModel !== null && chatModel.degraded === null) {
    return {
      apiKey: chatModel.apiKey,
      baseUrl: chatModel.baseUrl,
      model: chatModel.model,
      provider: chatModel.provider,
      source: 'chat-model',
      modelEntryId: chatModel.id,
      degraded,
    };
  }
  if (chatModel !== null && chatModel.degraded !== null) {
    degraded = degraded ?? chatModel.degraded;
  }

  // 3) 回落到 .env 平台默认
  const cfg = getLlm();
  return {
    apiKey: cfg.llmApiKey,
    baseUrl: cfg.llmBaseUrl,
    model: cfg.llmModel,
    provider: cfg.provider,
    source: 'process-default',
    modelEntryId: null,
    degraded,
  };
}

/**
 * 解析记忆抽取该用哪个模型（B4）。
 *
 * 抽取要输出结构化 JSON，推理型模型的思考 token 全额算输出 token ——
 * 用对话那个模型，一次抽取实测 2000+ token，而租户没有任何办法把它切便宜。
 * 租户在 `/admin/models` 里加一条 `usage_scope='memory'` 的模型条目就能解决。
 */
export async function resolveExtractionLlm(tenantId: string): Promise<ResolvedScopedLlm> {
  return resolveScopedLlm(tenantId, 'memory');
}

/**
 * 解析会话摘要该用哪个模型（B1 摘要压缩）。
 *
 * 跟抽取同一个道理：摘要是**独立的一次 LLM 调用**（每轮对话最多一次），
 * 租户用推理型模型时这一项就是纯成本。
 * 租户在 `/admin/models` 里加一条 `usage_scope='summary'` 的模型条目就能解决。
 */
export async function resolveSummaryLlm(tenantId: string): Promise<ResolvedScopedLlm> {
  return resolveScopedLlm(tenantId, 'summary');
}
