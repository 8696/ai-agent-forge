#!/usr/bin/env tsx
/**
 * 探活脚本：MySQL 是否可达
 * 用法：
 *   yarn tsx scripts/probe.ts
 *
 * （LLM 探活随 agent-orchestrator / lib/llm 删除一并移除 —— 后端不再调 LLM）
 */
import 'dotenv/config';
import { config } from '../src/config';
import mysql from 'mysql2/promise';

async function probeMysql(): Promise<void> {
  console.log('[1/1] MySQL 探活');
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

async function main(): Promise<void> {
  await probeMysql();
}

main().catch((err: unknown) => {
  console.error('脚本异常：', err);
  process.exit(1);
});
