#!/usr/bin/env tsx
/**
 * 一键幂等 seed 测试 fixture —— docs/12-d §D6 测试基建契约
 *
 * 用法：yarn seed
 *
 * 产物：
 *   - DB 里：1 system user + 2 tenants (acme / globex) + 各租户 1 admin + 1 customer + 1 API key
 *   - 控制台：打印全部凭据（含 API key raw）供复制
 *   - 不会自动跑 e2e:login —— seed 跟 login 解耦，seed 完调接口看是不是登录可用
 *
 * 幂等：跑 N 次结果一致；API key 每次重生成（hash 不可复用）。
 */
import 'dotenv/config';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { seedFixtures, getFixtures, writeTokensFile } from '../helpers';

async function main(): Promise<void> {
  const fx = await seedFixtures();

  console.log('\n=== ✅ 测试 fixture 已就绪 ===\n');

  console.log('【SaaS 平台方 system user】');
  console.log(`  email:    ${fx.systemUser.email}`);
  console.log(`  password: ${fx.systemUser.password}`);
  console.log(`  id:       ${fx.systemUser.id}`);

  console.log('\n【测试租户】');
  for (const t of fx.tenants) {
    console.log(`\n  租户 ${t.code} (id=${t.tenantId})：`);
    console.log(`    admin:    ${t.admin.email} / ${t.admin.password}`);
    console.log(`    customer: ${t.customer.email} / ${t.customer.password}`);
    console.log(`    API key:  ${t.apiKey.raw}  (name=${t.apiKey.name}, prefix=${t.apiKey.prefix})`);
  }

  // 把 API key 落盘到 .e2e-tokens.json（JWT 字段留空，等 e2e:login 填）
  // 这样 web/e2e/login-all.mjs 只负责登录，不用关心 API key（hash 不能反推）
  await writeTokensFile({
    system: '',
    acmeAdmin: '',
    acmeCustomer: '',
    globAdmin: '',
    globCustomer: '',
    acmeApiKey: fx.tenants.find((t) => t.code === 'acme')?.apiKey.raw ?? '',
    globApiKey: fx.tenants.find((t) => t.code === 'globex')?.apiKey.raw ?? '',
  });
  const tokensPath = path.resolve(process.cwd(), '.e2e-tokens.json');
  console.log(`\n  📝 已写 API key 到 ${tokensPath}（JWT 字段待 e2e:login 填）`);

  console.log('\n【下一步】');
  console.log('  yarn e2e:login           # 走完 5 个 /login 拿 JWT，填到 .e2e-tokens.json');
  console.log('  yarn test:fixtures       # seed + login 一条龙\n');

  void getFixtures;
}

main().catch((e: unknown) => {
  console.error('seed 失败：', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
