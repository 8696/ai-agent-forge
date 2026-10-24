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
 * 环境变量里的布尔值：认 `1/0`、`true/false`、`yes/no`、`on/off`（大小写不敏感）。
 *
 * **不能用 `z.coerce.boolean()`**：它走 JS 真值转换，字符串 `"false"` 会被当成 `true` ——
 * 写 `CONFIG_ALLOW_PRIVATE_LLM_ENDPOINT=false` 反而把开关打开了。
 * env 里的东西一律是字符串，所以这个转换必须显式做。
 */
const toBool = (value: unknown): unknown => {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return value;
  const v = value.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off' || v === '') return false;
  return value;
};

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

  // === 租户级配置（C3 / C4）===
  // 租户自定义 apiKey 的落库加密密钥（AES-256-GCM）。留空 = 禁止保存 apiKey。
  // 生产必须配；配了之后**永远别换**（换了对不上的旧密文解不出来）
  CONFIG_ENCRYPTION_KEY: z.string().default(''),
  // 是否允许租户把 LLM 端点指向内网地址。dev 默认放开；生产默认拦截（SSRF 防护，
  // 详见 src/lib/llm-endpoint.ts）。要指自建局域网网关时显式设 true
  CONFIG_ALLOW_PRIVATE_LLM_ENDPOINT: z.preprocess(toBool, z.boolean().default(false)),

  // === 对话（B1 · 多轮对话 + LLM 流式）===
  // 输入侧总 token 预算：system prompt + 历史 + 检索片段三块之和
  CHAT_CONTEXT_TOKEN_BUDGET: z.coerce.number().int().positive().default(8000),
  // 估算高估的安全垫比例（0.15 = 留 15% 给估算误差）
  CHAT_BUDGET_SAFETY_RATIO: z.coerce.number().min(0).max(0.5).default(0.15),
  // 最多带多少轮历史进 prompt（先按轮数砍，再按 token 预算砍）
  CHAT_MAX_HISTORY_TURNS: z.coerce.number().int().positive().default(10),
  // 检索片段的 token 上限
  CHAT_RETRIEVAL_TOKEN_BUDGET: z.coerce.number().int().positive().default(2500),
  // 系统提示词的 token 上限（默认提示词约 330 token，600 绰绰有余）
  CHAT_SYSTEM_TOKEN_BUDGET: z.coerce.number().int().positive().default(600),
  // RAG topK（传给 hybridSearch 的候选池大小；真正进 prompt 的条数由 token 预算裁剪决定）
  CHAT_RETRIEVAL_TOP_K: z.coerce.number().int().min(1).max(50).default(5),
  // 单次回复最大输出 token
  CHAT_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(2048),
  // 单条用户消息最长字符数
  CHAT_MAX_INPUT_CHARS: z.coerce.number().int().positive().default(2000),
  // 生成温度
  CHAT_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
  // SSE 心跳间隔（ms），<=0 关闭；部署在 nginx 后面建议保持 >0
  CHAT_KEEPALIVE_MS: z.coerce.number().int().nonnegative().default(15000),
  // 思考模式预算 token；0 = 关闭（provider 不一定支持，见 docs/06 §6.4）
  CHAT_THINKING_BUDGET_TOKENS: z.coerce.number().int().nonnegative().default(0),

  // === JWT ===
  JWT_SECRET: z.string().min(32, 'JWT_SECRET 至少 32 字符'),
  JWT_EXPIRES_IN: z.string().default('7d'),

  // === 安全防护（D4 · docs/12-d-需求-运维稳定.md §D4）===
  // 敏感数据脱敏（身份证 / 银行卡 / 手机号 → ***）：无条件开着，关掉就等于往历史里存明文
  SECURITY_PII_MASK_ENABLED: z.preprocess(toBool, z.boolean().default(true)),
  // 敏感词库审核（暴力 / 色情 / 政治 / 歧视）
  SECURITY_SENSITIVE_WORDS_ENABLED: z.preprocess(toBool, z.boolean().default(true)),
  // 提示词注入检测（规则层）
  SECURITY_INJECTION_ENABLED: z.preprocess(toBool, z.boolean().default(true)),
  // 注入检测的大模型二次确认策略：
  //   confirm = 只在规则命中时问模型（默认，省钱）
  //   always  = 每条输入都问模型（最严，也最贵）
  //   off     = 不问模型，只用规则
  SECURITY_INJECTION_LLM_MODE: z.enum(['confirm', 'always', 'off']).default('confirm'),
  // 输出审核的大模型复核（默认关：一次回答要额外一次 LLM 调用，且 SSE 已经把字节发出去了，
  // 复核只能事后纠正、不能真正「不返回给用户」；词库那层是常开的）
  SECURITY_OUTPUT_LLM_CHECK: z.preprocess(toBool, z.boolean().default(false)),
  // 审核类 LLM 调用的超时（毫秒）—— 超了就按「判不出来」处理，不拖住用户请求
  SECURITY_GUARD_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),

  // === 限流（D5 · docs/12-d-需求-运维稳定.md §D5）===
  RATE_LIMIT_ENABLED: z.preprocess(toBool, z.boolean().default(true)),
  // 限流窗口长度（毫秒）
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  // 单租户窗口内最大请求数（0 = 不限）；租户可在「租户设置」里覆盖
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().nonnegative().default(100),
  // 单用户窗口内最大请求数（0 = 不限）；租户可在「租户设置」里覆盖
  RATE_LIMIT_MAX_REQUESTS_PER_USER: z.coerce.number().int().nonnegative().default(30),

  // === 成本控制（D3 · docs/12-d-需求-运维稳定.md §D3）===
  COST_TRACKING_ENABLED: z.preprocess(toBool, z.boolean().default(true)),
  // 超过租户月度 token 阈值时是否**直接拒绝**新请求。
  // 默认只告警不拦截 —— 拦掉意味着租户的用户直接用不了 AI，
  // 那是运营决策（该在后台看到告警后自己降配额 / 提示用户），不该由平台默认替租户做。
  COST_BUDGET_BLOCK: z.preprocess(toBool, z.boolean().default(false)),
  // 自定义价格表（JSON，美元 / 100 万 token）：{"模型id": {"input": 0.6, "output": 2.2}}
  COST_PRICE_TABLE: z.string().default(''),

  // === 观测（D2）===
  // 采集 trace / span。关掉后调用方拿到的是空实现 handle（不用改业务代码）
  TRACE_ENABLED: z.preprocess(toBool, z.boolean().default(true)),
  // 同时往 logs/trace-YYYY-MM-DD.jsonl 写一份副本（docs/09-观测方案.md §9.1）
  TRACE_FILE_ENABLED: z.preprocess(toBool, z.boolean().default(true)),

  // === 评测（D1）===
  EVALUATION_ENABLED: z.preprocess(toBool, z.boolean().default(true)),
  // 单个评测集最多多少条题。一条题 = 2 次 LLM 调用（生成 + 裁判），
  // 上限是成本闸门：防止一次误传 5000 条把额度烧光
  EVALUATION_MAX_ITEMS: z.coerce.number().int().positive().default(50),

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

  // 对话（B1）配置整体冻一块：这些值是「一次调用内不许变」的，
  // 业务代码按 destructure 取，改了要重启才生效（跟 .env 的语义一致）
  CHAT: Object.freeze({
    /** 输入侧总 token 预算（system + 历史 + 检索片段） */
    CONTEXT_TOKEN_BUDGET: env.CHAT_CONTEXT_TOKEN_BUDGET,
    /** 估算高估的安全垫比例 */
    BUDGET_SAFETY_RATIO: env.CHAT_BUDGET_SAFETY_RATIO,
    MAX_HISTORY_TURNS: env.CHAT_MAX_HISTORY_TURNS,
    RETRIEVAL_TOKEN_BUDGET: env.CHAT_RETRIEVAL_TOKEN_BUDGET,
    SYSTEM_TOKEN_BUDGET: env.CHAT_SYSTEM_TOKEN_BUDGET,
    RETRIEVAL_TOP_K: env.CHAT_RETRIEVAL_TOP_K,
    MAX_OUTPUT_TOKENS: env.CHAT_MAX_OUTPUT_TOKENS,
    MAX_INPUT_CHARS: env.CHAT_MAX_INPUT_CHARS,
    TEMPERATURE: env.CHAT_TEMPERATURE,
    KEEPALIVE_MS: env.CHAT_KEEPALIVE_MS,
    THINKING_BUDGET_TOKENS: env.CHAT_THINKING_BUDGET_TOKENS,
  }),

  LLM_PROVIDER: env.LLM_PROVIDER,
  LLM_MODEL: env.LLM_MODEL,
  LLM_EMBEDDING_MODEL: env.LLM_EMBEDDING_MODEL,

  JWT_SECRET: env.JWT_SECRET,
  JWT_EXPIRES_IN: env.JWT_EXPIRES_IN,

  CONFIG_ENCRYPTION_KEY: env.CONFIG_ENCRYPTION_KEY,
  CONFIG_ALLOW_PRIVATE_LLM_ENDPOINT: env.CONFIG_ALLOW_PRIVATE_LLM_ENDPOINT,

  // 安全防护（D4）
  SECURITY: Object.freeze({
    PII_MASK_ENABLED: env.SECURITY_PII_MASK_ENABLED,
    SENSITIVE_WORDS_ENABLED: env.SECURITY_SENSITIVE_WORDS_ENABLED,
    INJECTION_ENABLED: env.SECURITY_INJECTION_ENABLED,
    INJECTION_LLM_MODE: env.SECURITY_INJECTION_LLM_MODE,
    OUTPUT_LLM_CHECK: env.SECURITY_OUTPUT_LLM_CHECK,
    GUARD_TIMEOUT_MS: env.SECURITY_GUARD_TIMEOUT_MS,
  }),

  // 限流（D5）
  RATE_LIMIT: Object.freeze({
    ENABLED: env.RATE_LIMIT_ENABLED,
    WINDOW_MS: env.RATE_LIMIT_WINDOW_MS,
    MAX_REQUESTS: env.RATE_LIMIT_MAX_REQUESTS,
    MAX_REQUESTS_PER_USER: env.RATE_LIMIT_MAX_REQUESTS_PER_USER,
  }),

  // 成本控制（D3）
  COST: Object.freeze({
    TRACKING_ENABLED: env.COST_TRACKING_ENABLED,
    BUDGET_BLOCK: env.COST_BUDGET_BLOCK,
    PRICE_TABLE: env.COST_PRICE_TABLE,
  }),

  // 观测（D2）
  OBSERVABILITY: Object.freeze({
    TRACE_ENABLED: env.TRACE_ENABLED,
    TRACE_FILE_ENABLED: env.TRACE_FILE_ENABLED,
  }),

  // 评测（D1）
  EVALUATION: Object.freeze({
    ENABLED: env.EVALUATION_ENABLED,
    MAX_ITEMS: env.EVALUATION_MAX_ITEMS,
  }),

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
