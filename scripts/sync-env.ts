#!/usr/bin/env tsx
/**
 * 同步 .env 和 .env.example
 *
 * 约定：两个文件结构完全一致（同一组 key，同一顺序，同一注释）。
 * 值的差异规则：
 *   - *_API_KEY / *_PASSWORD / *_SECRET：.env 写真值，.env.example 留空
 *   - 其他配置：dev 用本地默认（localhost / OpenAI 默认等）；当 .env 有 override 时
 *     （比如用远程 MySQL / 远程 Qdrant / 切换 Embedding provider），sync 会保留 .env 的真值，
 *     不会用模板覆盖
 *
 * 用法：yarn tsx scripts/sync-env.ts
 *
 * 行为：
 * 1. 读 .env.example 作为结构模板（注释 / 顺序 / section 标题）
 * 2. 读 .env 提取当前的真值（key → value 映射）
 * 3. 写 .env：模板结构 + 真值（dev override 保留）
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

function isCommentOrBlank(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === '' || trimmed.startsWith('#');
}

const realValues = parseEnv(fs.readFileSync(ENV_PATH, 'utf-8'));
const template = fs.readFileSync(EXAMPLE_PATH, 'utf-8');

const envLines: string[] = [];
const exampleLines: string[] = [];

let preservedRealCount = 0;
let clearedSecretCount = 0;
let preservedOverrideCount = 0;

// 1. 遍历模板的每一行，保持结构 + 决定值
for (const line of template.split('\n')) {
  const m = line.match(KV_LINE);
  if (m && m[1] !== undefined) {
    const key = m[1];
    const isSecret = SECRET_KEY.test(key);
    if (isSecret) {
      const realValue = realValues.get(key) ?? '';
      if (realValue.trim() !== '') preservedRealCount += 1;
      clearedSecretCount += 1;
      envLines.push(`${key}=${realValue}`);
      exampleLines.push(`${key}=`);
    } else {
      // 非 secret：优先用 .env 的值（dev override 保留），没有就回退到模板
      const realValue = realValues.get(key);
      if (realValue !== undefined && realValue !== m[2]) {
        preservedOverrideCount += 1;
        envLines.push(`${key}=${realValue}`);
      } else {
        envLines.push(line);
      }
      exampleLines.push(line);
    }
  } else {
    // 注释 / 空行：原样保留
    envLines.push(line);
    exampleLines.push(line);
  }
}

// 2. 把 .env 有但 .env.example 没有的 key 也带上（防御：避免 dev 新加的 key 被吃掉）
const templateKeys = new Set<string>();
for (const line of template.split('\n')) {
  const m = line.match(KV_LINE);
  if (m && m[1] !== undefined) templateKeys.add(m[1]);
}
for (const [key, value] of realValues) {
  if (!templateKeys.has(key)) {
    envLines.push(`${key}=${value}`);
    // .env.example：secret 清空，其他同步保留
    if (SECRET_KEY.test(key)) {
      exampleLines.push(`${key}=`);
    } else {
      exampleLines.push(`${key}=${value}`);
    }
  }
}

fs.writeFileSync(ENV_PATH, envLines.join('\n'));
fs.writeFileSync(EXAMPLE_PATH, exampleLines.join('\n'));

console.log(
  `✅ 同步完成：模板 ${envLines.length} 行；保留真值 ${preservedRealCount} 个；清空 secret 行 ${clearedSecretCount} 处；保留 dev override ${preservedOverrideCount} 处`,
);
console.log(`   .env          → ${ENV_PATH}`);
console.log(`   .env.example  → ${EXAMPLE_PATH}`);
console.log('   提示：git diff 这两个文件应只看到 *_KEY / *_PASSWORD / *_SECRET 几行的差异');
console.log('         （dev override 的非 secret 行也会不同，预期内；切回本地默认就把 .env 改回 localhost）');
// 静默导入以避免 lint 报未用
void isCommentOrBlank;
