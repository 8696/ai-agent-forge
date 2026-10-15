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
 * 详见 docs/03-技术栈与规范.md §A.12 + docs/07-大模型与Embedding.md §7.1
 *
 * 设计要点：
 *  - LLM_PROVIDER 一键切换：选哪家，所有 LLM / Embedding 走那家
 *  - 每个 provider 配两套 baseURL：
 *      *_BASE_URL         → OpenAI 兼容（给 Embedding REST 用）
 *      *_ANTHROPIC_BASE_URL → Anthropic 协议（给 Vercel AI SDK 调 LLM 用）
 *  - 切换 provider 只改 LLM_PROVIDER；切模型 id 改对应 *_MODEL / *_EMBEDDING_MODEL
 *  - 真实凭据只放 .env（gitignored），.env.example 提供空占位
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  // PORT 默认值根据 NODE_ENV 派生（test → 3099，避免跟 dev/prod 的 3000 冲突）。
  // 这里留 optional，派生在下面 .envSchema.safeParse() 之后做。
  PORT: z.coerce.number().int().positive().optional(),

  // === MySQL ===
  MYSQL_HOST: z.string().min(1).default('localhost'),
  MYSQL_PORT: z.coerce.number().int().positive().default(3306),
  MYSQL_USER: z.string().min(1).default('root'),
  MYSQL_PASSWORD: z.string().default(''),
  MYSQL_DB: z.string().min(1).default('agent_platform'),

  // === Qdrant（Step 4+ 用）===
  QDRANT_URL: z.string().url().default('http://localhost:6333'),
  QDRANT_COLLECTION: z.string().default('documents'),

  // === 知识库 / 文件上传（Step 4）===
  DATA_DIR: z.string().default('./data'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(50 * 1024 * 1024),
  // 拆块参数（与 docs/05-b §5.6 + docs/15 §Step 4 一致：800 / 150）
  CHUNK_SIZE: z.coerce.number().int().positive().default(800),
  CHUNK_OVERLAP: z.coerce.number().int().positive().default(150),

  // === LLM provider 一键切换 =========================================
  LLM_PROVIDER: z.enum(['minimax', 'zhipu', 'deepseek', 'qwen', 'custom']).default('minimax'),
  // 留空 = 用该 provider 的默认 model id；填写则 Anthropic 协议 LLM 都用这个
  LLM_MODEL: z.string().default(''),
  // 留空 = 用该 provider 的默认 embedding model id；没嵌入接口的 provider（DeepSeek）这一行留空
  LLM_EMBEDDING_MODEL: z.string().default(''),

  // === 每个 provider 的 Anthropic 协议凭据（Vercel AI SDK 用） ======
  // MiniMax（https://api.minimaxi.com/anthropic）
  MINIMAX_API_KEY: optionalStr,
  MINIMAX_BASE_URL: optionalUrl,
  MINIMAX_MODEL: z.string().default('MiniMax-M3'),
  MINIMAX_ANTHROPIC_BASE_URL: optionalUrl,
  MINIMAX_ANTHROPIC_MODEL: z.string().default('MiniMax-M3'),
  MINIMAX_EMBEDDING_MODEL: z.string().default('embo-01'),

  // 智谱（https://open.bigmodel.cn/api/anthropic）
  ZHIPU_API_KEY: optionalStr,
  ZHIPU_BASE_URL: optionalUrl,
  ZHIPU_MODEL: z.string().default('glm-5.3'),
  ZHIPU_ANTHROPIC_BASE_URL: optionalUrl,
  ZHIPU_ANTHROPIC_MODEL: z.string().default('glm-5.3'),
  ZHIPU_EMBEDDING_MODEL: z.string().default('embedding-3'),

  // DeepSeek（https://api.deepseek.com/anthropic）
  DEEPSEEK_API_KEY: optionalStr,
  DEEPSEEK_BASE_URL: optionalUrl,
  DEEPSEEK_MODEL: z.string().default('deepseek-v4-pro'),
  DEEPSEEK_ANTHROPIC_BASE_URL: optionalUrl,
  DEEPSEEK_ANTHROPIC_MODEL: z.string().default('deepseek-v4-pro'),
  DEEPSEEK_EMBEDDING_MODEL: z.string().default(''),

  // 千问（https://dashscope.aliyuncs.com/apps/anthropic）
  QWEN_API_KEY: optionalStr,
  QWEN_BASE_URL: optionalUrl,
  QWEN_MODEL: z.string().default('qwen3.8-max'),
  QWEN_ANTHROPIC_BASE_URL: optionalUrl,
  QWEN_ANTHROPIC_MODEL: z.string().default('qwen3.8-max'),
  QWEN_EMBEDDING_MODEL: z.string().default('text-embedding-v3'),

  // 自定义网关（Anthropic 协议 / OpenAI 兼容都支持）
  CUSTOM_API_KEY: optionalStr,
  CUSTOM_BASE_URL: optionalUrl,
  CUSTOM_MODEL: z.string().default(''),
  CUSTOM_ANTHROPIC_BASE_URL: optionalUrl,
  CUSTOM_ANTHROPIC_MODEL: z.string().default(''),
  CUSTOM_EMBEDDING_MODEL: z.string().default(''),

  // === JWT ===
  JWT_SECRET: z.string().min(32, 'JWT_SECRET 至少 32 字符'),
  JWT_EXPIRES_IN: z.string().default('7d'),

  // === 日志 ===
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('❌ 环境变量校验失败：');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const env = {
  ...parsed.data,
  PORT: parsed.data.PORT ?? (parsed.data.NODE_ENV === 'test' ? 3099 : 3000),
};

export type LlmProvider = 'minimax' | 'zhipu' | 'deepseek' | 'qwen' | 'custom';

/**
 * 单个 provider 的所有 LLM + Embedding 配置
 * 来自 *.env，per-provider 集中
 */
export interface ProviderConfig {
  readonly provider: LlmProvider;
  /** Anthropic 协议 LLM 用的 apiKey（Vercel AI SDK 调 chat 用） */
  readonly llmApiKey: string;
  /** Anthropic 协议 LLM 用的 baseUrl（Vercel AI SDK 调 chat 用） */
  readonly llmBaseUrl: string;
  /** Anthropic 协议 LLM 用的 model id */
  readonly llmModel: string;
  /** OpenAI 兼容 Embedding 用的 apiKey（独立 REST） */
  readonly embedApiKey: string;
  /** OpenAI 兼容 Embedding 用的 baseUrl */
  readonly embedBaseUrl: string;
  /** OpenAI 兼容 Embedding 用的 model id */
  readonly embedModel: string;
  /** Embedding 输出维度（hardcode 在代码里，不从 env 读） */
  readonly embedDimensions: number;
}

/**
 * Per-provider 维度表（按各 provider 公开文档的默认维度）
 * 改 model 时如果该 model 维度变化，需要在这里同步加
 *  - MiniMax embo-01：1024
 *  - 智谱 embedding-3：2048（默认；支持 1024/768/512）
 *  - DeepSeek：暂未提供 Embedding；用 DeepSeek 的不能跑 Step 4
 *  - 千问 text-embedding-v3：1024
 */
const PROVIDER_EMBED_DIMENSIONS: Record<LlmProvider, number> = {
  minimax: 1024,
  zhipu: 2048,
  deepseek: 0, // 不支持；调用时抛错
  qwen: 1024,
  custom: 1536, // custom 默认按 OpenAI text-embedding-3-small 算；调用方要按实际调整
};

function buildProviderConfig(p: LlmProvider): ProviderConfig {
  const llmOverride = env.LLM_MODEL.trim() !== '' ? env.LLM_MODEL : null;
  const embedOverride = env.LLM_EMBEDDING_MODEL.trim() !== '' ? env.LLM_EMBEDDING_MODEL : null;

  switch (p) {
    case 'minimax': {
      const apiKey = env.MINIMAX_API_KEY;
      const anthropicBase = env.MINIMAX_ANTHROPIC_BASE_URL;
      const openaiBase = env.MINIMAX_BASE_URL;
      if (apiKey === undefined || apiKey.trim() === '') {
        throw new Error('MINIMAX_API_KEY 未配置');
      }
      if (anthropicBase === undefined || anthropicBase.trim() === '') {
        throw new Error('MINIMAX_ANTHROPIC_BASE_URL 未配置');
      }
      if (openaiBase === undefined || openaiBase.trim() === '') {
        throw new Error('MINIMAX_BASE_URL 未配置');
      }
      return {
        provider: 'minimax',
        llmApiKey: apiKey,
        llmBaseUrl: normalizeAnthropicBaseUrl(anthropicBase),
        llmModel: llmOverride ?? env.MINIMAX_ANTHROPIC_MODEL,
        embedApiKey: apiKey,
        embedBaseUrl: openaiBase.replace(/\/+$/, ''),
        embedModel: embedOverride ?? env.MINIMAX_EMBEDDING_MODEL,
        embedDimensions: PROVIDER_EMBED_DIMENSIONS.minimax,
      };
    }
    case 'zhipu': {
      const apiKey = env.ZHIPU_API_KEY;
      const anthropicBase = env.ZHIPU_ANTHROPIC_BASE_URL;
      const openaiBase = env.ZHIPU_BASE_URL;
      if (apiKey === undefined || apiKey.trim() === '') {
        throw new Error('ZHIPU_API_KEY 未配置');
      }
      if (anthropicBase === undefined || anthropicBase.trim() === '') {
        throw new Error('ZHIPU_ANTHROPIC_BASE_URL 未配置');
      }
      if (openaiBase === undefined || openaiBase.trim() === '') {
        throw new Error('ZHIPU_BASE_URL 未配置');
      }
      return {
        provider: 'zhipu',
        llmApiKey: apiKey,
        llmBaseUrl: normalizeAnthropicBaseUrl(anthropicBase),
        llmModel: llmOverride ?? env.ZHIPU_ANTHROPIC_MODEL,
        embedApiKey: apiKey,
        embedBaseUrl: openaiBase.replace(/\/+$/, ''),
        embedModel: embedOverride ?? env.ZHIPU_EMBEDDING_MODEL,
        embedDimensions: PROVIDER_EMBED_DIMENSIONS.zhipu,
      };
    }
    case 'deepseek': {
      const apiKey = env.DEEPSEEK_API_KEY;
      const anthropicBase = env.DEEPSEEK_ANTHROPIC_BASE_URL;
      if (apiKey === undefined || apiKey.trim() === '') {
        throw new Error('DEEPSEEK_API_KEY 未配置');
      }
      if (anthropicBase === undefined || anthropicBase.trim() === '') {
        throw new Error('DEEPSEEK_ANTHROPIC_BASE_URL 未配置');
      }
      // DeepSeek 不提供 Embedding；返回时 embedModel 留空，调用方自己判断
      return {
        provider: 'deepseek',
        llmApiKey: apiKey,
        llmBaseUrl: normalizeAnthropicBaseUrl(anthropicBase),
        llmModel: llmOverride ?? env.DEEPSEEK_ANTHROPIC_MODEL,
        embedApiKey: apiKey,
        embedBaseUrl: env.DEEPSEEK_BASE_URL?.replace(/\/+$/, '') ?? '',
        embedModel: embedOverride ?? env.DEEPSEEK_EMBEDDING_MODEL,
        embedDimensions: PROVIDER_EMBED_DIMENSIONS.deepseek,
      };
    }
    case 'qwen': {
      const apiKey = env.QWEN_API_KEY;
      const anthropicBase = env.QWEN_ANTHROPIC_BASE_URL;
      const openaiBase = env.QWEN_BASE_URL;
      if (apiKey === undefined || apiKey.trim() === '') {
        throw new Error('QWEN_API_KEY 未配置');
      }
      if (anthropicBase === undefined || anthropicBase.trim() === '') {
        throw new Error('QWEN_ANTHROPIC_BASE_URL 未配置');
      }
      if (openaiBase === undefined || openaiBase.trim() === '') {
        throw new Error('QWEN_BASE_URL 未配置');
      }
      return {
        provider: 'qwen',
        llmApiKey: apiKey,
        llmBaseUrl: normalizeAnthropicBaseUrl(anthropicBase),
        llmModel: llmOverride ?? env.QWEN_ANTHROPIC_MODEL,
        embedApiKey: apiKey,
        embedBaseUrl: openaiBase.replace(/\/+$/, ''),
        embedModel: embedOverride ?? env.QWEN_EMBEDDING_MODEL,
        embedDimensions: PROVIDER_EMBED_DIMENSIONS.qwen,
      };
    }
    case 'custom': {
      const apiKey = env.CUSTOM_API_KEY;
      const anthropicBase = env.CUSTOM_ANTHROPIC_BASE_URL;
      const openaiBase = env.CUSTOM_BASE_URL;
      if (apiKey === undefined || apiKey.trim() === '') {
        throw new Error('CUSTOM_API_KEY 未配置');
      }
      if (anthropicBase === undefined || anthropicBase.trim() === '') {
        throw new Error('CUSTOM_ANTHROPIC_BASE_URL 未配置');
      }
      if (openaiBase === undefined || openaiBase.trim() === '') {
        throw new Error('CUSTOM_BASE_URL 未配置');
      }
      return {
        provider: 'custom',
        llmApiKey: apiKey,
        llmBaseUrl: normalizeAnthropicBaseUrl(anthropicBase),
        llmModel: llmOverride ?? env.CUSTOM_ANTHROPIC_MODEL,
        embedApiKey: apiKey,
        embedBaseUrl: openaiBase.replace(/\/+$/, ''),
        embedModel: embedOverride ?? env.CUSTOM_EMBEDDING_MODEL,
        embedDimensions: PROVIDER_EMBED_DIMENSIONS.custom,
      };
    }
  }
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

/**
 * 取 LLM 完整配置（Vercel AI SDK 调 chat 用）
 *  - provider：用于监控 / 审计（不要作为限流 key）
 *  - apiKey / baseUrl / model：直接给 createAnthropic({ baseURL, apiKey }) 和 anthropic(model)
 */
export function resolveLlm(provider: LlmProvider = env.LLM_PROVIDER): ProviderConfig {
  return buildProviderConfig(provider);
}

/**
 * 取 Embedding 完整配置（独立 OpenAI 兼容 REST 客户端用）
 *  - 跟 resolveLlm 共用 provider 开关（LLM_PROVIDER 一键切）
 *  - 维度由 provider 决定，调用方不用关心
 *  - DeepSeek 等不支持 embedding 的 provider 会抛错
 */
export function resolveEmbedding(provider: LlmProvider = env.LLM_PROVIDER): ProviderConfig {
  const cfg = buildProviderConfig(provider);
  if (cfg.embedModel === '' || cfg.embedDimensions === 0) {
    throw new Error(`LLM provider ${cfg.provider} 不提供 Embedding；切其他 provider 或 LLM_EMBEDDING_MODEL 显式指定别的 endpoint`);
  }
  return cfg;
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
  QDRANT_COLLECTION: env.QDRANT_COLLECTION,

  DATA_DIR: env.DATA_DIR,
  MAX_UPLOAD_BYTES: env.MAX_UPLOAD_BYTES,
  CHUNK_SIZE: env.CHUNK_SIZE,
  CHUNK_OVERLAP: env.CHUNK_OVERLAP,

  LLM_PROVIDER: env.LLM_PROVIDER,
  LLM_MODEL: env.LLM_MODEL,
  LLM_EMBEDDING_MODEL: env.LLM_EMBEDDING_MODEL,

  JWT_SECRET: env.JWT_SECRET,
  JWT_EXPIRES_IN: env.JWT_EXPIRES_IN,

  LOG_LEVEL: env.LOG_LEVEL,
});

export type AppConfig = typeof config;

/**
 * 在需要真正发起 LLM 调用时再调，避免冷启动（如 server.ts 不直接 import llm）。
 * 缺凭据时抛错，业务路由层应捕获并降级到错误提示。
 */
export function getLlm(): ProviderConfig {
  return resolveLlm();
}
