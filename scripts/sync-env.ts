#!/usr/bin/env tsx
/**
 * 同步 .env 和 .env.example
 *
 * 约定：两个文件结构完全一致。唯一的差异是「*_API_KEY / *_PASSWORD / *_SECRET」几行——
 * .env 写真值，.env.example 留空。
 *
 * 用法：yarn tsx scripts/sync-env.ts
 *
 * 行为：
 * 1. 读 .env.example 作为结构模板（注释、顺序、section 标题都来自这里）
 * 2. 读 .env 提取当前的真值（key → value 映射）
 * 3. 写 .env：模板结构 + 真值
 * 4. 写 .env.example：模板结构 + secret 行清空
 *
 * 安全：本脚本全程不在终端打印任何 key / password / secret 的值
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROJECT_ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(PROJECT_ROOT, '.env');
const EXAMPLE_PATH = path.join(PROJECT_ROOT, '.env.example');

const KV_LINE = /^([A-Z_][A-Z0-9_]*)=(.*)$/;
const SECRET_KEY = /KEY|SECRET|PASSWORD/;

function parseEnv(content: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of content.split('\n')) {
    const m = line.match(KV_LINE);
    if (m && m[1] !== undefined && m[2] !== undefined) {
      map.set(m[1], m[2]);
    }
  }
  return map;
}

const realValues = parseEnv(fs.readFileSync(ENV_PATH, 'utf-8'));
const template = fs.readFileSync(EXAMPLE_PATH, 'utf-8');

const envLines: string[] = [];
const exampleLines: string[] = [];

let preservedRealCount = 0;
let clearedSecretCount = 0;

for (const line of template.split('\n')) {
  const m = line.match(KV_LINE);
  if (m && m[1] !== undefined && m[2] !== undefined) {
    const key = m[1];
    const isSecret = SECRET_KEY.test(key);
    if (isSecret) {
      const realValue = realValues.get(key) ?? '';
      if (realValue.trim() !== '') preservedRealCount += 1;
      clearedSecretCount += 1;
      envLines.push(`${key}=${realValue}`);
      exampleLines.push(`${key}=`);
    } else {
      envLines.push(line);
      exampleLines.push(line);
    }
  } else {
    envLines.push(line);
    exampleLines.push(line);
  }
}

fs.writeFileSync(ENV_PATH, envLines.join('\n'));
fs.writeFileSync(EXAMPLE_PATH, exampleLines.join('\n'));

console.log(
  `✅ 同步完成：模板 ${envLines.length} 行；保留真值 ${preservedRealCount} 个；清空 secret 行 ${clearedSecretCount} 处`,
);
console.log(`   .env          → ${ENV_PATH}`);
console.log(`   .env.example  → ${EXAMPLE_PATH}`);
console.log('   提示：git diff 这两个文件应只看到 *_KEY / *_PASSWORD / *_SECRET 几行的差异');
