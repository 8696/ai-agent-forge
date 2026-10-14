#!/usr/bin/env tsx
/**
 * 全局探活脚本：
 * 1. MySQL 是否可达
 * 2. 当前 LLM_PROVIDER 的 Anthropic 协议端点是否通
 * 3. 其他有 *_API_KEY 的提供商也顺手探一下（验证「切换提供商」可用）
 *
 * 用法：
 *   yarn tsx scripts/probe.ts                    # 探默认 LLM_PROVIDER + 其它有 key 的
 *   yarn tsx scripts/probe.ts --provider=zhipu   # 强制把 zhipu 当作主用探（不改 .env）
 *   LLM_PROVIDER=deepseek yarn tsx scripts/probe.ts   # 用 .env 切主用
 */
import 'dotenv/config';
import { config, resolveLlm, type LlmProvider } from '../src/config';
import mysql from 'mysql2/promise';
import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText } from 'ai';

const PLACEHOLDER = '__PUT_YOUR_';

function keyLooksReal(value: string | undefined): boolean {
  if (value === undefined) return false;
  if (value.trim() === '') return false;
  if (value.includes(PLACEHOLDER)) return false;
  return value.length >= 16;
}

async function probeMysql(): Promise<void> {
  console.log('\n[1/2] MySQL 探活');
  const t0 = Date.now();
  try {
    const conn = await mysql.createConnection({
      host: config.MYSQL.HOST,
      port: config.MYSQL.PORT,
      user: config.MYSQL.USER,
      password: config.MYSQL.PASSWORD,
      database: config.MYSQL.DB,
      connectTimeout: 5_000,
    });
    const [rows] = await conn.query('SELECT VERSION() AS v, DATABASE() AS db, NOW() AS now');
    console.log(`  ✓ ${Date.now() - t0}ms | ${JSON.stringify(rows)}`);
    await conn.end();
  } catch (err: unknown) {
    console.log(`  ✗ ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function probeLlm(provider: LlmProvider): Promise<void> {
  const apiKey = process.env[`${provider.toUpperCase()}_API_KEY`];
  if (!keyLooksReal(apiKey)) {
    const reason =
      apiKey === undefined || apiKey.trim() === ''
        ? '未配置'
        : `仍是占位符（长度 ${apiKey.length}）`;
    console.log(`\n[2/2] LLM[${provider}] 跳过（_API_KEY ${reason}）`);
    return;
  }

  console.log(`\n[2/2] LLM[${provider}] 探活`);
  const t0 = Date.now();
  try {
    const cfg = resolveLlm(provider);
    const client = createAnthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl });
    const res = await generateText({
      model: client(cfg.model),
      prompt: 'reply with the single word: pong',
      maxTokens: 32,
    });
    const dur = Date.now() - t0;
    console.log(
      `  ✓ ${dur}ms | model=${cfg.model} | base=${cfg.baseUrl} | text=${JSON.stringify(res.text)} | usage=${JSON.stringify(res.usage)}`,
    );
  } catch (err: unknown) {
    console.log(`  ✗ ${err instanceof Error ? err.message : String(err)}`);
  }
}

function getCliProvider(): LlmProvider | null {
  const arg = process.argv.find((s) => s.startsWith('--provider='));
  if (arg === undefined) return null;
  const value = arg.split('=')[1] as LlmProvider;
  if (!['minimax', 'zhipu', 'deepseek', 'qwen', 'custom'].includes(value)) {
    throw new Error(`--provider 取值必须是 minimax|zhipu|deepseek|qwen|custom，收到：${value}`);
  }
  return value;
}

async function main(): Promise<void> {
  await probeMysql();

  const override = getCliProvider();
  const active: LlmProvider = override ?? config.LLM_PROVIDER;
  console.log(
    `\nLLM_PROVIDER=${config.LLM_PROVIDER}${override !== null ? `（CLI 覆盖为 ${active}）` : ''}`,
  );

  // 先探主用（拿主用 key 探）
  await probeLlm(active);

  // 再顺手探其它有真实 key 的（自动跳过占位 / 未配置）
  if (override === null) {
    for (const p of ['minimax', 'zhipu', 'deepseek', 'qwen', 'custom'] as LlmProvider[]) {
      if (p === active) continue;
      await probeLlm(p);
    }
  }
}

main().catch((err: unknown) => {
  console.error('脚本异常：', err);
  process.exit(1);
});
