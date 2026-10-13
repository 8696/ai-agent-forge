#!/usr/bin/env tsx
/**
 * Smoke test：仅验证模块能正常 import + umzug 能发现迁移文件。
 * 不连数据库。
 */
import 'reflect-metadata';
import { glob } from 'node:fs/promises';

async function main(): Promise<void> {
  console.log('--- smoke: import 入口 ---');
  // import() 副作用 import 即可验证装饰器 / 类型链
  await import('../src/config.js');
  console.log('  ✓ src/config.ts');
  await import('../src/logger.js');
  console.log('  ✓ src/logger.ts');
  await import('../src/lib/errors.js');
  console.log('  ✓ src/lib/errors.ts');
  await import('../src/models/Tenant.js');
  console.log('  ✓ src/models/Tenant.ts');
  await import('../src/models/User.js');
  console.log('  ✓ src/models/User.ts');
  await import('../src/models/index.js');
  console.log('  ✓ src/models/index.ts');

  console.log('--- smoke: 发现迁移文件 ---');
  const baseUrl = new URL('../src/migrations/', import.meta.url);
  let count = 0;
  for await (const file of glob('*.ts', { cwd: new URL('./', baseUrl) })) {
    if (file === 'runner.ts') continue;
    count += 1;
    console.log(`  ✓ ${file}`);
  }
  console.log(`--- 共 ${count} 个迁移文件 ---`);

  console.log('\n所有可静态验证的项目通过。');
  console.log('下一步：连上 MySQL，跑 `yarn migrate`，再 `yarn dev`。');
}

main().catch((err: unknown) => {
  console.error('smoke test 失败：', err);
  process.exit(1);
});
