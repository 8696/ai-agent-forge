import 'dotenv/config';
import { z } from 'zod';

/**
 * 把空字符串或纯空白视作 undefined（处理 dotenv 没填的字段）。
 */
const emptyToUndef = (value: unknown): unknown => {
  if (typeof value === 'string' && value.trim() === '') {
    return undefined;
  }
  return value;
};

const optionalStr = z.preprocess(emptyToUndef, z.string().optional());
const optionalUrl = z.preprocess(emptyToUndef, z.string().url().optional());

/**
 * 环境变量校验，启动时缺必填项直接挂，避免带着错误配置继续服务。
 * 详见 docs/03-技术栈与规范.md §A.12 + docs/07-大模型与Embedding.md §7.1 / §7.3
 *
 * LLM 设计要点：
 * - 所有提供商走 Vercel AI SDK + Anthropic 兼容协议（§7.1）
 * - 切换提供商 = 改 LLM_PROVIDER；model id 默认跟提供商走，LLM_MODEL 留空即用提供商默认 model
 * - 真实凭据只放 .env（gitignored），.env.example 提供空占位
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  // MySQL
  MYSQL_HOST: z.string().min(1).default('localhost'),
  MYSQL_PORT: z.coerce.number().int().positive().default(3306),
  MYSQL_USER: z.string().min(1).default('root'),
  MYSQL_PASSWORD: z.string().default(''),
  MYSQL_DB: z.string().min(1).default('agent_platform'),

  // Qdrant（Step 4+ 用）
  QDRANT_URL: z.string().url().default('http://localhost:6333'),

  // === LLM provider switch ============================================
  // 主用切这里；备选自动按 LLM_PROVIDER 走对应 *_ANTHROPIC_* 凭据（§7.3）
  LLM_PROVIDER: z.enum(['minimax', 'zhipu', 'deepseek', 'qwen', 'custom']).default('minimax'),
  // 留空 = 用提供商默认 model id；填写则所有提供商用这个 id
  LLM_MODEL: z.string().default(''),

  // === 每个提供商的 Anthropic 协议凭据 ================================
  // 当前阶段所有 LLM 调用一律走 Anthropic 兼容协议，不引 OpenAI-Compatible 客户端

  // MiniMax（https://api.minimaxi.com/anthropic）
  MINIMAX_API_KEY: optionalStr,
  MINIMAX_ANTHROPIC_BASE_URL: optionalUrl,
  MINIMAX_ANTHROPIC_MODEL: z.string().default('MiniMax-M3'),

  // 智谱（https://open.bigmodel.cn/api/anthropic）
  ZHIPU_API_KEY: optionalStr,
  ZHIPU_ANTHROPIC_BASE_URL: optionalUrl,
  ZHIPU_ANTHROPIC_MODEL: z.string().default('glm-5.3'),

  // DeepSeek（https://api.deepseek.com/anthropic）
  DEEPSEEK_API_KEY: optionalStr,
  DEEPSEEK_ANTHROPIC_BASE_URL: optionalUrl,
  DEEPSEEK_ANTHROPIC_MODEL: z.string().default('deepseek-v4-pro'),

  // 千问（https://dashscope.aliyuncs.com/apps/anthropic）
  QWEN_API_KEY: optionalStr,
  QWEN_ANTHROPIC_BASE_URL: optionalUrl,
  QWEN_ANTHROPIC_MODEL: z.string().default('qwen3.8-max'),

  // 自定义网关（用户自有 Anthropic-兼容代理）
  CUSTOM_API_KEY: optionalStr,
  CUSTOM_ANTHROPIC_BASE_URL: optionalUrl,
  CUSTOM_ANTHROPIC_MODEL: z.string().default(''),

  // === JWT ============================================================
  JWT_SECRET: z.string().min(32, 'JWT_SECRET 至少 32 字符'),
  JWT_EXPIRES_IN: z.string().default('7d'),

  // === Embedding（独立 REST，不走 Vercel AI SDK）=======================
  EMBEDDING_API_KEY: optionalStr,
  EMBEDDING_BASE_URL: optionalUrl,

  // === 日志 ===========================================================
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('❌ 环境变量校验失败：');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const env = parsed.data;

/**
 * 当前生效的 LLM 提供商 —— 调用方拿到这个直接喂给 Vercel AI SDK 即可。
 * - provider：用于监控 / 审计（不要作为限流 key）
 * - apiKey / baseUrl / model：直接给 createAnthropic({ baseURL, apiKey }) 和 anthropic(model)
 */
export type LlmProvider = 'minimax' | 'zhipu' | 'deepseek' | 'qwen' | 'custom';

export interface LlmConfig {
  readonly provider: LlmProvider;
  readonly protocol: 'anthropic';
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
}

function pick(
  provider: LlmProvider,
  apiKey: string | undefined,
  baseUrl: string | undefined,
  defaultModel: string,
): LlmConfig {
  if (apiKey === undefined || apiKey.trim() === '') {
    throw new Error(`${provider.toUpperCase()}_API_KEY 未配置`);
  }
  if (baseUrl === undefined || baseUrl.trim() === '') {
    throw new Error(`${provider.toUpperCase()}_ANTHROPIC_BASE_URL 未配置`);
  }
  const model = env.LLM_MODEL !== '' ? env.LLM_MODEL : defaultModel;
  if (model.trim() === '') {
    throw new Error(`${provider.toUpperCase()}_ANTHROPIC_MODEL 或 LLM_MODEL 至少填一个`);
  }
  return {
    provider,
    protocol: 'anthropic',
    apiKey,
    baseUrl: normalizeAnthropicBaseUrl(baseUrl),
    model,
  };
}

/**
 * Vercel AI SDK v1 的 @ai-sdk/anthropic 把 baseURL 当作 "messages 端点的前缀"，
 * 拼出 `${baseURL}/messages`（不附 /v1）。default baseURL 是 `https://api.anthropic.com/v1`，
 * 隐含约定：用户填的 baseURL 必须以 `/v1` 结尾。
 *
 * 各网关文档给的 "Anthropic 兼容端点" 通常是 `…/anthropic`（不带 /v1），
 * 实际消息路径是 `…/anthropic/v1/messages`。这里把 baseURL 规范化成 SDK 期望的形式。
 * 已经以 /v1 结尾的不重复加。
 */
export function normalizeAnthropicBaseUrl(url: string): string {
  const trimmed = url.replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

export function resolveLlm(provider: LlmProvider = env.LLM_PROVIDER): LlmConfig {
  switch (provider) {
    case 'minimax':
      return pick(
        'minimax',
        env.MINIMAX_API_KEY,
        env.MINIMAX_ANTHROPIC_BASE_URL,
        env.MINIMAX_ANTHROPIC_MODEL,
      );
    case 'zhipu':
      return pick(
        'zhipu',
        env.ZHIPU_API_KEY,
        env.ZHIPU_ANTHROPIC_BASE_URL,
        env.ZHIPU_ANTHROPIC_MODEL,
      );
    case 'deepseek':
      return pick(
        'deepseek',
        env.DEEPSEEK_API_KEY,
        env.DEEPSEEK_ANTHROPIC_BASE_URL,
        env.DEEPSEEK_ANTHROPIC_MODEL,
      );
    case 'qwen':
      return pick('qwen', env.QWEN_API_KEY, env.QWEN_ANTHROPIC_BASE_URL, env.QWEN_ANTHROPIC_MODEL);
    case 'custom':
      return pick(
        'custom',
        env.CUSTOM_API_KEY,
        env.CUSTOM_ANTHROPIC_BASE_URL,
        env.CUSTOM_ANTHROPIC_MODEL,
      );
  }
}

export const config = Object.freeze({
  NODE_ENV: env.NODE_ENV,
  PORT: env.PORT,

  MYSQL: Object.freeze({
    HOST: env.MYSQL_HOST,
    PORT: env.MYSQL_PORT,
    USER: env.MYSQL_USER,
    PASSWORD: env.MYSQL_PASSWORD,
    DB: env.MYSQL_DB,
  }),

  QDRANT_URL: env.QDRANT_URL,

  LLM_PROVIDER: env.LLM_PROVIDER,
  LLM_MODEL: env.LLM_MODEL,

  JWT_SECRET: env.JWT_SECRET,
  JWT_EXPIRES_IN: env.JWT_EXPIRES_IN,

  EMBEDDING_API_KEY: env.EMBEDDING_API_KEY,
  EMBEDDING_BASE_URL: env.EMBEDDING_BASE_URL,

  LOG_LEVEL: env.LOG_LEVEL,
});

export type AppConfig = typeof config;

/**
 * 在需要真正发起 LLM 调用时再调，避免冷启动（如 server.ts 不直接 import llm）。
 * 缺凭据时抛错，业务路由层应捕获并降级到错误提示。
 */
export function getLlm(): LlmConfig {
  return resolveLlm();
}
