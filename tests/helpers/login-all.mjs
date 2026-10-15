#!/usr/bin/env node
/**
 * 前端测试登录脚本 —— docs/16-d §D6 测试基建契约
 *
 * 用法：yarn e2e:login
 *
 * 模拟三个子系统的登录页（/system/login / /admin/login / /customer/login）：
 *   - system 子系统：1 个 platform-admin 登录
 *   - admin 子系统：acme + globex 各 1 个 admin 登录
 *   - customer 子系统：acme + globex 各 1 个 customer 登录
 *   - 对外 API key：seed 已生成，复制到 .e2e-tokens.json
 *
 * 产物：.e2e-tokens.json（含 system / acmeAdmin / acmeCustomer / globAdmin / globCustomer / acmeApiKey / globApiKey 共 7 个 key）
 *       前后端测试脚本都从这里读现成 JWT，0 网络请求。
 *
 * 前提：yarn seed 已经跑过（API key 在 seed 时生成；脚本里读 fixtures.json 反查不到 key）。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..'); // tests/helpers/ → 项目根（要往上两级）
const FIXTURES = path.resolve(ROOT, 'tests/fixtures/fixtures.json');
const TOKENS_FILE = path.resolve(ROOT, '.e2e-tokens.json');

const API_BASE = process.env.API_BASE ?? `http://localhost:${process.env.PORT ?? '3099'}`;

const tenants = [
  { code: 'acme', label: { admin: 'acmeAdmin', customer: 'acmeCustomer' }, apiKeyLabel: 'acmeApiKey' },
  { code: 'globex', label: { admin: 'globAdmin', customer: 'globCustomer' }, apiKeyLabel: 'globApiKey' },
];

async function postJson(p, body) {
  const res = await fetch(`${API_BASE}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${p} → status=${res.status} body=${text}`);
  let j;
  try { j = JSON.parse(text); } catch (e) { throw new Error(`${p}: JSON 解析失败（${text}）`); }
  if (typeof j.token !== 'string') throw new Error(`${p}: 响应缺 token 字段（${text}）`);
  return j.token;
}

async function main() {
  const raw = await fs.readFile(FIXTURES, 'utf8');
  const fx = JSON.parse(raw);

  console.log(`\n=== 前端 E2E 登录（API_BASE=${API_BASE}）===\n`);

  const tokens = {};

  console.log('【SaaS 平台方】');
  tokens.system = await postJson('/api/v1/system/login', {
    email: fx.system.email,
    password: fx.system.password,
  });
  console.log(`  ✅ system JWT (${tokens.system.length} chars)`);

  for (const t of tenants) {
    const cfg = fx.tenants.find((x) => x.code === t.code);
    if (!cfg) throw new Error(`fixtures.json 缺租户 ${t.code}`);
    console.log(`\n【租户 ${t.code}】`);

    tokens[t.label.admin] = await postJson('/api/v1/admin/login', {
      email: cfg.admin.email,
      password: cfg.admin.password,
      tenant_code: t.code,
    });
    console.log(`  ✅ ${t.label.admin} JWT (${tokens[t.label.admin].length} chars)`);

    tokens[t.label.customer] = await postJson('/api/v1/customer/login', {
      email: cfg.customer.email,
      password: cfg.customer.password,
      tenant_code: t.code,
    });
    console.log(`  ✅ ${t.label.customer} JWT (${tokens[t.label.customer].length} chars)`);

    // API key 不能从 fixtures.json 反查（hash 不能反推），要 seed.ts 把 raw 写进 .e2e-tokens.json
    console.log(`  ⏸  ${t.apiKeyLabel} 等 seed.ts 写入`);
  }

  // 合并 seed.ts 写入的 API key（如果 seed 已跑过）
  let merged = tokens;
  try {
    const existing = JSON.parse(await fs.readFile(TOKENS_FILE, 'utf8'));
    merged = { ...tokens, acmeApiKey: existing.acmeApiKey, globApiKey: existing.globApiKey };
    console.log('\n  ✅ 已合并 seed.ts 写入的 API key');
  } catch {
    console.log('\n  ⚠️  .e2e-tokens.json 不存在或解析失败 —— API key 待 seed.ts 写入');
  }

  await fs.writeFile(TOKENS_FILE, JSON.stringify(merged, null, 2));
  console.log(`\n=== ✅ 写入 ${path.relative(ROOT, TOKENS_FILE)}（${Object.keys(merged).length} 个 key）===\n`);
  console.log('【用法】');
  console.log('  后端集成测试：yarn test:integration                    # 跑 tests/integration/*.test.ts');
  console.log('  老 Step 验收：yarn tsx tests/integration/test-stepN.ts # 仍按需手动跑');
  console.log('  前端测试（未来）：yarn test:e2e                        # Playwright，Step 13 UI 验收再加\n');
}

main().catch((e) => {
  console.error('\n❌', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
