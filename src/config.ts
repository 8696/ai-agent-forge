import 'dotenv/config';
import { z } from 'zod';

/**
 * 把空字符串视作 undefined（处理 dotenv 没填的字段）
 */
const optionalString = z
  .string()
  .transform((s) => (s.trim() === '' ? undefined : s))
  .optional();

/**
 * 环境变量校验，启动时缺必填项直接挂，避免带着错误配置继续服务。
 * 详见 docs/03-技术栈与规范.md §A.12
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

  // Qdrant
  QDRANT_URL: z.string().url().default('http://localhost:6333'),

  // LLM（Anthropic 协议）
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY 不能为空'),
  ANTHROPIC_BASE_URL: z.string().url().optional(),

  // JWT
  JWT_SECRET: z.string().min(32, 'JWT_SECRET 至少 32 字符'),
  JWT_EXPIRES_IN: z.string().default('7d'),

  // Embedding
  EMBEDDING_API_KEY: optionalString,
  EMBEDDING_BASE_URL: z
    .string()
    .url()
    .optional()
    .or(z.literal(''))
    .transform((s) => (typeof s === 'string' && s.trim() === '' ? undefined : s)),

  // 日志
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  // 配置错误直接挂，不带着错误配置继续服务。
  console.error('❌ 环境变量校验失败：');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
export type AppConfig = typeof config;
