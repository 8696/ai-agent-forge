#!/usr/bin/env node
/**
 * 验证「迁移 034 没跑时」的降级是否真的生效 —— 端到端回归工具
 *
 * ## 为什么需要这个
 *
 * 迁移 `034-add-api-key-sha256` 给 `api_keys` 加了 `key_sha256` 列。
 * 生产部署是「DBA 手动跑迁移 + 灰度」（docs/11），
 * **代码可能先于迁移上线** —— 这时列不存在，
 * 而 Sequelize 的 SELECT 列清单来自**模型定义**，
 * 所以**任何**对 api_keys 的查询都会报「Unknown column 'key_sha256'」：
 * 鉴权挂、后台的密钥列表 / 改权限 / 撤销也一起挂。
 *
 * 本脚本在**一个 scratch 库**里制造出「代码新、schema 旧」的真实状态，
 * 然后逐条验证降级行为。
 *
 * ## 跑法
 *
 *   node scripts/check-api-key-degradation.mjs
 *   KEEP_SCRATCH=1 node scripts/check-api-key-degradation.mjs   # 跑完保留 scratch 库
 *
 * ⚠️ 只会碰一个名字固定的 scratch 库（默认 `agent_platform_degrade_test`），
 *    **不会碰 .env 里配的那个库**。
 * ⚠️ 需要 .env 里的 MySQL 账号有 CREATE/DROP DATABASE 权限。
 */
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';

const SCRATCH_DB = process.env.SCRATCH_DB ?? 'agent_platform_degrade_test';
const PORT = process.env.CHECK_PORT ?? '3097';
const BASE = `http://localhost:${PORT}`;
const KEEP = process.env.KEEP_SCRATCH === '1';
/** seed 会把 API key 写进这个文件 —— scratch 库的 key 不能污染共享的凭据文件 */
const TOKENS_PATH = path.resolve(process.cwd(), '.e2e-tokens.json');

const results = [];
function check(label, ok, extra = '') {
  results.push({ label, ok });
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? '  ' + extra : ''}`);
}

function run(cmd, args, env = {}) {
  const r = spawnSync(cmd, args, {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} 失败（退出码 ${r.status}）`);
  }
}

// ── 1) 准备 scratch 库 ──────────────────────────────
console.log(`\n=== 1/5 准备 scratch 库：${SCRATCH_DB} ===`);
const admin = await mysql.createConnection({
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT ?? 3306),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  connectTimeout: 20000,
});
const [dbs] = await admin.query('SHOW DATABASES');
if (dbs.some((d) => d.Database === SCRATCH_DB)) {
  console.log('  库已存在，复用');
} else {
  await admin.query(
    `CREATE DATABASE \`${SCRATCH_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
  console.log('  库已建');
}
await admin.end();

// ── 2) 跑全部迁移 + seed ──────────────────────────
console.log('\n=== 2/5 迁移 + seed ===');
// ⚠️ seed 会把 scratch 库的 API key 写进共享的 .e2e-tokens.json —— 先存一份，跑完还原
const tokensBackup = existsSync(TOKENS_PATH) ? readFileSync(TOKENS_PATH, 'utf8') : null;
run('yarn', ['migrate'], { MYSQL_DB: SCRATCH_DB });
run('yarn', ['seed'], { MYSQL_DB: SCRATCH_DB });

// ── 3) 把 034 的效果回退掉（= 迁移没跑）────────────
console.log('\n=== 3/5 回退 034（制造「代码新、schema 旧」）===');
const conn = await mysql.createConnection({
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT ?? 3306),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: SCRATCH_DB,
  connectTimeout: 20000,
});
const [cols] = await conn.query(
  'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?',
  [SCRATCH_DB, 'api_keys', 'key_sha256'],
);
if (cols.length > 0) {
  await conn.query('ALTER TABLE api_keys DROP COLUMN key_sha256');
}
await conn.query(
  "ALTER TABLE api_keys MODIFY COLUMN scope ENUM('read','write','admin') NOT NULL DEFAULT 'write' " +
    "COMMENT '权限分级：read=只读（不能发起对话）/ write=可发起对话（默认） / admin=管理员（预留）'",
);
await conn.query("DELETE FROM sequelize_meta WHERE name = '034-add-api-key-sha256'");
const [left] = await conn.query(
  'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?',
  [SCRATCH_DB, 'api_keys', 'key_sha256'],
);
check('scratch 库里没有 key_sha256 列（= 迁移没跑的状态）', left.length === 0);

// ── 4) 起一个指向 scratch 库的后端 ──────────────────
console.log('\n=== 4/5 起后端（当前代码 + 旧 schema）===');
// ⚠️ 必须用 spawn + detached（不能用 spawnSync）：
//    spawnSync 会等 shell 退出，而后台服务的 stdout 还连着 shell → 一直阻塞
const { spawn } = await import('node:child_process');
const child = spawn(
  'npx',
  ['tsx', 'src/server.ts'],
  {
    cwd: process.cwd(),
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, NODE_ENV: 'test', PORT, MYSQL_DB: SCRATCH_DB },
  },
);
child.unref();
const serverPid = child.pid ?? 0;
let up = false;
for (let i = 0; i < 90; i += 1) {
  try {
    const r = await fetch(`${BASE}/api/health`);
    if (r.ok) { up = true; break; }
  } catch { /* 还没起来 */ }
  await new Promise((r) => setTimeout(r, 1000));
}
if (!up) {
  console.log('  ❌ 后端没起来');
  if (serverPid > 0) { try { process.kill(serverPid); } catch { /* ignore */ } }
  process.exit(1);
}
console.log(`  后端就绪（PID ${serverPid}）`);

// ── 5) 逐条验证 ────────────────────────────────────
console.log('\n=== 5/5 验证降级行为 ===');
try {
  const login = await fetch(`${BASE}/api/v1/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenant_code: 'acme',
      email: 'admin@acme.test',
      password: 'AcmeAdmin-123!',
    }),
  });
  check('admin 登录', login.status === 200, `→ ${login.status}`);
  const { token } = await login.json();

  const created = await fetch(`${BASE}/api/v1/admin/api-keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: `降级验证-${Date.now()}`, scope: 'admin' }),
  });
  check('建 API Key（列不存在时不该挂）', created.status === 201, `→ ${created.status}`);
  const body = await created.json();
  const raw = body.api_key;

  const authed = await fetch(`${BASE}/api/v1/public/documents`, {
    headers: { Authorization: `Bearer ${raw}` },
  });
  check('用这把 key 鉴权（降级到前缀粗筛）', authed.status === 200, `→ ${authed.status}`);

  const list = await fetch(`${BASE}/api/v1/admin/api-keys`, {
    headers: { authorization: `Bearer ${token}` },
  });
  check('后台 key 列表', list.status === 200, `→ ${list.status}`);

  const patched = await fetch(`${BASE}/api/v1/admin/api-keys/${body.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ scope: 'write' }),
  });
  check('改权限', patched.status === 200, `→ ${patched.status}`);

  const revoked = await fetch(`${BASE}/api/v1/admin/api-keys/${body.id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
  check('撤销', revoked.status === 200, `→ ${revoked.status}`);

  const bogus = await fetch(`${BASE}/api/v1/public/documents`, {
    headers: { Authorization: 'Bearer ak_thiskeydoesnotexist0000000000000000' },
  });
  check('不存在的 key 被拒（降级不能把鉴权放开）', bogus.status === 401, `→ ${bogus.status}`);
} finally {
  await conn.end();
  if (serverPid > 0) {
    try { process.kill(serverPid); } catch { /* 已经退了 */ }
  }
  // 还原共享的凭据文件（seed 写过它）
  if (tokensBackup !== null) {
    writeFileSync(TOKENS_PATH, tokensBackup);
    console.log('\n（.e2e-tokens.json 已还原）');
  }
  if (!KEEP) {
    const cleanup = await mysql.createConnection({
      host: process.env.MYSQL_HOST,
      port: Number(process.env.MYSQL_PORT ?? 3306),
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      connectTimeout: 20000,
    });
    await cleanup.query(`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``);
    await cleanup.end();
    console.log(`\n（scratch 库 ${SCRATCH_DB} 已清理；KEEP_SCRATCH=1 可保留）`);
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===`);
if (failed.length > 0) {
  console.log('失败项：');
  for (const f of failed) console.log('  -', f.label);
  process.exit(1);
}
