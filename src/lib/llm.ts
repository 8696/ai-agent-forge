import { createAnthropic } from '@ai-sdk/anthropic';
import { resolveLlm, type ProviderConfig } from '../config';

/**
 * Vercel AI SDK 的 Anthropic provider 工厂 —— 详见 docs/16-c §C4 + docs/15 §Step 6
 *
 * 设计要点：
 *  - LLM_PROVIDER 一键切换：minimax / zhipu / deepseek / qwen / custom 全部走 Anthropic 协议
 *  - baseURL / apiKey / model 全部从 env 经 resolveLlm() 解析
 *  - 切换 provider / model：改 .env，重启生效（参见 docs/07-大模型与Embedding.md §7.1）
 *  - 不缓存 provider 实例：每次 buildLlm() 都重新解析；调用方在请求生命周期内可复用返回值
 *
 * 用途：
 *   const { model } = buildLlm();
 *   streamText({ model, system, messages });
 */
export interface BuiltLlm {
  /** 解析出的 provider（用于监控 / 审计） */
  readonly provider: ProviderConfig['provider'];
  /** Vercel AI SDK 的 LanguageModel 实例，直接喂给 streamText / generateText */
  readonly model: ReturnType<ReturnType<typeof createAnthropic>>;
  /** 当前生效的 model id（便于日志 / observability） */
  readonly modelId: string;
  /** 解析出的 baseURL（用于日志） */
  readonly baseUrl: string;
}

export function buildLlm(): BuiltLlm {
  const cfg = resolveLlm();
  const anthropic = createAnthropic({
    apiKey: cfg.llmApiKey,
    baseURL: cfg.llmBaseUrl,
  });
  return {
    provider: cfg.provider,
    model: anthropic(cfg.llmModel),
    modelId: cfg.llmModel,
    baseUrl: cfg.llmBaseUrl,
  };
}
