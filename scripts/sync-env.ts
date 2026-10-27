#!/usr/bin/env tsx
/**
 * 同步 `.env` 和 `.env.example`
 *
 * ## 契约
 *
 *  - **`.env.example` 是结构模板**（唯一真源）：同一组 key、同一顺序、同一段注释
 *  - `.env` = 模板结构 + 本地真值
 *  - 值的差异：
 *      - `*_API_KEY` / `*_PASSWORD` / `*_SECRET`：`.env` 写真值，`.env.example` 留空
 *      - 其他：`.env.example` 是本地默认；`.env` 可以是 dev override（远程 MySQL / 切 provider）
 *  - **唯一真源是 `src/config.ts` 的 `envSchema`** —— 只有它读到的变量才算数
 *
 * ## 用法
 *
 *   yarn env:sync    # 同步（写两个文件）
 *   yarn env:check   # 只报告不写；有问题退出码 1（提交前 / CI 跑这个）
 *
 * ## 三类问题，处置方式不一样
 *
 *  1. **代码 ↔ 文件对不上**（死 key / 漏配）→ **只报告，不自动改**。
 *     这类必须人拍板：key 是代码删了文件没删，还是文件写了代码没读。
 *  2. **`.env` 缺 key / 顺序或注释不一致** → **自动修**（模板说了算）。
 *  3. **`.env` 有、模板没有的 key** → **只报告，不自动改**。
 *     早期版本把这种 key 追加到文件末尾、还把它的值抄进 `.env.example` ——
 *     ① key 脱离了它该在的 section，后来的人不知道它是什么；
 *     ② dev 的远程地址 / 自定义值被抄进**进 git 的模板**里。
 *
 * ## 安全
 *
 * 全程不在终端打印任何 key / password / secret 的值（报告里也打码）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KV_LINE,
  OPTIONAL_ENV_KEYS,
  isSecretKey,
  parseEnvContent,
  schemaEnvKeys,
} from './env-contract';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROJECT_ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(PROJECT_ROOT, '.env');
const EXAMPLE_PATH = path.join(PROJECT_ROOT, '.env.example');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'src/config.ts');

const CHECK_ONLY = process.argv.includes('--check');

function readFileOrFail(p: string, label: string): string {
  if (!fs.existsSync(p)) {
    console.error(`❌ 找不到 ${label}：${p}`);
    console.error(`   （.env 是本地文件、已 gitignore；第一次 clone 后从 .env.example 复制一份）`);
    process.exit(1);
  }
  return fs.readFileSync(p, 'utf-8');
}

/** 打码：secret 的值永远不落到终端 */
function mask(key: string, value: string): string {
  if (!isSecretKey(key)) return value;
  if (value === '') return '(空)';
  return '(有值，已打码)';
}

const envContent = readFileOrFail(ENV_PATH, '.env');
const exampleContent = readFileOrFail(EXAMPLE_PATH, '.env.example');
const configContent = readFileOrFail(CONFIG_PATH, 'src/config.ts');

const envParsed = parseEnvContent(envContent);
const exampleParsed = parseEnvContent(exampleContent);
const schemaKeys = schemaEnvKeys(configContent);

if (schemaKeys.length < 50) {
  console.error(
    `❌ 从 src/config.ts 只抠出 ${schemaKeys.length} 个 env 变量 —— 抠取逻辑坏了（envSchema 的写法变了？）`,
  );
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════════════
// 1. 代码 ↔ 文件：死 key / 漏配（只报告，人来拍板）
// ═══════════════════════════════════════════════════════════════════
const schemaSet = new Set(schemaKeys);
const envSet = new Set(envParsed.keys);
const exampleSet = new Set(exampleParsed.keys);

// 死 key：文件里有、代码不读
const deadInEnv = envParsed.keys.filter((k) => !schemaSet.has(k));
const deadInExample = exampleParsed.keys.filter((k) => !schemaSet.has(k));
// 漏配：代码读、文件里没有（且不在 7 个例外里）
const missingInEnv = schemaKeys.filter((k) => !envSet.has(k) && !OPTIONAL_ENV_KEYS.has(k));
const missingInExample = schemaKeys.filter((k) => !exampleSet.has(k) && !OPTIONAL_ENV_KEYS.has(k));

// ═══════════════════════════════════════════════════════════════════
// 2. .env ↔ 模板：多余 key（只报告）、缺 key / 顺序注释（自动修）
// ═══════════════════════════════════════════════════════════════════
const extraInEnv = envParsed.keys.filter((k) => !exampleSet.has(k));

// 按模板结构重建两个文件的内容
const envLines: string[] = [];
const exampleLines: string[] = [];
const filledFromTemplate: string[] = [];
const preservedOverrides: string[] = [];

for (const line of exampleContent.split('\n')) {
  const m = line.match(KV_LINE);
  if (!m || m[1] === undefined) {
    // 注释 / 空行：两个文件一样
    envLines.push(line);
    exampleLines.push(line);
    continue;
  }

  const key = m[1];
  const templateValue = m[2] ?? '';

  if (isSecretKey(key)) {
    // secret：.env 保留真值，模板强制留空（真值绝不能进 git）
    envLines.push(`${key}=${envParsed.values.get(key) ?? ''}`);
    exampleLines.push(`${key}=`);
    continue;
  }

  // 非 secret：.env 保留自己的值（dev override 合法），模板保持模板值
  const realValue = envParsed.values.get(key);
  if (realValue === undefined) {
    filledFromTemplate.push(key);
    envLines.push(`${key}=${templateValue}`);
  } else {
    if (realValue !== templateValue) preservedOverrides.push(key);
    envLines.push(`${key}=${realValue}`);
  }
  exampleLines.push(line);
}

const newEnv = envLines.join('\n');
const newExample = exampleLines.join('\n');

// ═══════════════════════════════════════════════════════════════════
// 3. 报告
// ═══════════════════════════════════════════════════════════════════
let hasProblem = false;

if (deadInEnv.length > 0 || deadInExample.length > 0) {
  hasProblem = true;
  console.error('❌ 死 key：文件里有，但 src/config.ts 已经不读了');
  for (const k of new Set([...deadInEnv, ...deadInExample])) {
    const inEnv = deadInEnv.includes(k) ? '.env' : '';
    const inExample = deadInExample.includes(k) ? '.env.example' : '';
    console.error(`     ${k}   （在 ${[inEnv, inExample].filter(Boolean).join(' + ')} 里）`);
  }
  console.error('');
  console.error('   这说明当初改代码时忘了删文件里的行。两种处置：');
  console.error('     ① 代码确实不要这个变量了 → 从两个文件里都删掉');
  console.error('     ② 代码还要，只是没走 config.ts → 别删，但要把读取方式改到 config.ts 里');
  console.error('');
}

if (missingInEnv.length > 0 || missingInExample.length > 0) {
  hasProblem = true;
  console.error('❌ 漏配：src/config.ts 要读，但文件里没有');
  for (const k of new Set([...missingInEnv, ...missingInExample])) {
    console.error(`     ${k}`);
  }
  console.error('');
  console.error('   → 把它们补进 .env.example 对应的 section（值填默认值），再跑一次同步');
  console.error('');
}

if (extraInEnv.length > 0) {
  hasProblem = true;
  console.error('❌ .env 里有这些 key，.env.example（模板）里没有：');
  for (const k of extraInEnv) {
    console.error(`     ${k}=${mask(k, envParsed.values.get(k) ?? '')}`);
  }
  console.error('');
  console.error('   这有两种可能，脚本不替你猜，请自己判：');
  console.error('     ① 代码里已经不读这个 key 了（死 key）→ 把它从 .env 删掉');
  console.error('     ② 模板漏了这一节 → 把它补进 .env.example 对应的 section，再跑一次');
  console.error('');
}

const envChanged = newEnv !== envContent;
const exampleChanged = newExample !== exampleContent;

if (CHECK_ONLY) {
  if (!hasProblem && !envChanged && !exampleChanged) {
    console.log('✅ 一致：');
    console.log('   · 两个文件 key 集合 / 顺序 / 注释结构相同');
    console.log('   · 两边的 key 都在 src/config.ts 的 envSchema 里，没有死 key');
    console.log('   · envSchema 里的 key 都在两个文件里，没有漏配');
    console.log('   · .env.example 的 secret 行全部留空');
    process.exit(0);
  }
  if (envChanged) {
    console.error('❌ .env 的结构跟模板对不上（缺 key / 顺序或注释不一致）');
    console.error('   → 跑 `yarn env:sync` 同步');
  }
  if (exampleChanged) {
    console.error('❌ .env.example 跟预期不一致（secret 行没留空？）');
    console.error('   → 跑 `yarn env:sync` 同步');
  }
  console.error('');
  console.error('❌ 有问题未解决 —— 见上面各条');
  process.exit(1);
}

// 有「要人拍板」的问题时，不写任何文件（免得半同步）
if (hasProblem) {
  console.error('⚠️ 上面这些问题需要人拍板，本次没有写任何文件。');
  console.error('   处理完再跑一次 `yarn env:sync`。');
  process.exit(1);
}

fs.writeFileSync(ENV_PATH, newEnv);
fs.writeFileSync(EXAMPLE_PATH, newExample);

console.log('✅ 同步完成');
if (filledFromTemplate.length > 0) {
  console.log(`   · 用模板默认值补进 .env：${filledFromTemplate.length} 项`);
}
if (preservedOverrides.length > 0) {
  console.log(
    `   · 保留 dev override（值跟模板不同，属正常）：${preservedOverrides.join('、')}`,
  );
}
console.log(`   · secret 行：.env 保留真值，.env.example 已强制留空`);
if (!envChanged && !exampleChanged) {
  console.log('   · 两个文件本来就是一致的，没改动');
} else {
  console.log('   · .env / .env.example 已按模板结构对齐');
}
console.log('   提示：`git diff .env.example` 应该看不到非 secret 行的变化 ——');
console.log('         看到了说明模板里的值被误改过，检查一下');
