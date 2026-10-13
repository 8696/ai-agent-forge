#!/usr/bin/env tsx
/**
 * 迁移 CLI：yarn migrate   /   yarn migrate --undo
 * 详见 docs/03-技术栈与规范.md §B.2
 */
import 'reflect-metadata';
import { buildMigrator } from '../src/migrations/runner';
import { logger } from '../src/logger';

async function main(): Promise<void> {
  const migrator = buildMigrator();
  const undo = process.argv.includes('--undo');

  if (undo) {
    const reverted = await migrator.down();
    logger.info({ count: reverted.length }, '已撤销的迁移');
  } else {
    const applied = await migrator.up();
    logger.info({ count: applied.length }, '已执行的迁移');
  }

  // 退出前关掉连接，避免 tsx hang 住
  const { getSequelize } = await import('../src/db');
  await getSequelize().close();
  process.exit(0);
}

main().catch((err: unknown) => {
  logger.error({ err }, '迁移失败');
  process.exit(1);
});
