import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { OPTIONAL_ENV_KEYS, schemaEnvKeys } from '../../scripts/env-contract';

/**
 * **`.env` 和 `.env.example` 必须是同一份东西的两副面孔**
 *
 * ## 为什么要有这个
 *
 * 2026-10-27：用户问「这两个文件的配置说明为什么不一样？我都不知道哪个该删」。
 * 查下来是两个文件各自漂了半年没人管：
 *
 *  - `.env` 少 6 个 key（`TENANT_SCOPE_ENFORCE` / 熔断三项 / 记忆相关性两项）——
 *    这些是 2026-10-26 那批功能上线时只改了 `.env.example` 忘了改 `.env`
 *  - `.env` 多 1 个 `SECURITY_PII_MASK_ENABLED` —— **死 key**：
 *    脱敏开关 2026-10-26 就从代码里摘掉了（`src/config.ts` 不读它），
 *    文件里的行还留着，注释还写着「建议一直开着」
 *
 * 后果是：**「这个变量还有没有用」只能靠人翻代码判断** —— 而人判断不了，
 * 所以它就烂在那儿。
 *
 * ## 这个测试守什么
 *
 *  - `.env` ↔ `.env.example`：key 集合相同、**顺序相同**、**注释逐行相同**
 *  - 两个文件 ↔ `src/config.ts` 的 `envSchema`：
 *    - 文件里的 key **必须**是代码会读的（不许有死 key）
 *    - 代码会读的 key **必须**在文件里（不许漏配），除了 7 个登记的例外
 *  - `.env.example` 的 secret 行**必须留空**（真值漏进 git 的最后一道闸）
 *
 * ⚠️ **改了 `src/config.ts` 的 `envSchema` 而忘了改这两个文件，这个测试就会红** ——
 * 那是它该做的。
 *
 * ## 为什么 `.env` 那一组会 skip
 *
 * `.env` 是 **gitignored 的本地文件**（真值在里面，不进 git）——
 * CI / 换机器的 clone 上根本没有它。所以：
 *  - `.env.example` 那一组**永远跑**（它是进 git 的模板）
 *  - `.env` ↔ `.env.example` 那一组**本地跑**，`.env` 不在就跳过
 */
const ROOT = path.resolve(__dirname, '../..');
const ENV_PATH = path.join(ROOT, '.env');
const EXAMPLE_PATH = path.join(ROOT, '.env.example');
const CONFIG_PATH = path.join(ROOT, 'src/config.ts');

/** 一行 `KEY=value` */
const KV_LINE = /^([A-Z_][A-Z0-9_]*)=(.*)$/;
/** 哪些 key 算「密钥」—— 这些在 `.env.example` 里必须留空 */
const SECRET_KEY = /KEY|SECRET|PASSWORD/;

interface ParsedEnv {
  keys: string[];
  values: Map<string, string>;
}

function parseEnv(content: string): ParsedEnv {
  const keys: string[] = [];
  const values = new Map<string, string>();
  for (const line of content.split('\n')) {
    const m = line.match(KV_LINE);
    if (!m || m[1] === undefined) continue;
    if (!values.has(m[1])) keys.push(m[1]);
    values.set(m[1], m[2] ?? '');
  }
  return { keys, values };
}

/**
 * 把值抹掉、只留 key 和注释 —— 两个文件的这个逐行相等 == 结构完全一致。
 *
 * ⚠️ **行尾注释要留着**：`KEY=8000 # 自己加的` 里，`#` 后面那段是注释不是值。
 * 如果把它一起抹掉，两边就长得一样了 —— 但 `.env` 里那个 key 的**实际值**
 * 会变成 `8000 # 自己加的`（zod 校验直接挂）。
 */
function fingerprint(content: string): string[] {
  return content.split('\n').map((line) => {
    const m = line.match(KV_LINE);
    if (!m || m[1] === undefined) return line;
    const rest = m[2] ?? '';
    const hashIdx = rest.indexOf('#');
    const trailing = hashIdx === -1 ? '' : rest.slice(hashIdx);
    return `${m[1]}=${trailing}`;
  });
}

const envExists = existsSync(ENV_PATH);
const exampleContent = readFileSync(EXAMPLE_PATH, 'utf8');
const exampleParsed = parseEnv(exampleContent);
const envContent = envExists ? readFileSync(ENV_PATH, 'utf8') : '';
const envParsed = parseEnv(envContent);
const schemaKeys = schemaEnvKeys(readFileSync(CONFIG_PATH, 'utf8'));

describe('envSchema 抠取逻辑本身', () => {
  it('抠出来的 key 数量在合理区间（防「一个都没抠到 → 后面全部断言空过」）', () => {
    expect(schemaKeys.length).toBeGreaterThan(50);
    expect(schemaKeys.length).toBeLessThan(200);
  });

  it('抠出来的 key 没有重复', () => {
    expect(new Set(schemaKeys).size).toBe(schemaKeys.length);
  });
});

describe('.env ↔ .env.example · 结构一致', () => {
  it.skipIf(!envExists)('.env 存在（否则这组断言整体跳过）', () => {
    expect(envExists).toBe(true);
  });

  it.skipIf(!envExists)('key 集合相同', () => {
    expect([...envParsed.keys].sort()).toEqual([...exampleParsed.keys].sort());
  });

  it.skipIf(!envExists)('key 顺序相同', () => {
    expect(envParsed.keys).toEqual(exampleParsed.keys);
  });

  it.skipIf(!envExists)('注释 / 空行结构逐行相同', () => {
    const a = fingerprint(envContent);
    const b = fingerprint(exampleContent);
    const firstDiff = a.findIndex((line, i) => line !== b[i]);
    expect(
      firstDiff,
      firstDiff === -1
        ? ''
        : `第 ${firstDiff + 1} 行开始不一样：\n  .env         → ${a[firstDiff]}\n  .env.example → ${b[firstDiff]}`,
    ).toBe(-1);
    expect(a.length).toBe(b.length);
  });
});

describe('.env.example · secret 行必须留空', () => {
  it('没有真值漏进 git', () => {
    const leaked: string[] = [];
    for (const [key, value] of exampleParsed.values) {
      if (SECRET_KEY.test(key) && value.trim() !== '') leaked.push(key);
    }
    expect(
      leaked,
      `这些 secret 在 .env.example 里不是空的（真值会进 git）：${leaked.join('、')}`,
    ).toEqual([]);
  });
});

describe('两个 env 文件 ↔ src/config.ts 的 envSchema', () => {
  it('.env.example 里的 key 都是代码会读的（没有死 key）', () => {
    const schemaSet = new Set(schemaKeys);
    const dead = exampleParsed.keys.filter((k) => !schemaSet.has(k));
    expect(
      dead,
      `这些 key 在 src/config.ts 里已经没有读取方了 —— 死 key，从 .env.example 删掉：\n  ${dead.join('\n  ')}`,
    ).toEqual([]);
  });

  it.skipIf(!envExists)('.env 里的 key 都是代码会读的（没有死 key）', () => {
    const schemaSet = new Set(schemaKeys);
    const dead = envParsed.keys.filter((k) => !schemaSet.has(k));
    expect(
      dead,
      `这些 key 在 src/config.ts 里已经没有读取方了 —— 死 key，从 .env 删掉：\n  ${dead.join('\n  ')}`,
    ).toEqual([]);
  });

  it('代码会读的 key 都在 .env.example 里（除了 7 个登记的例外）', () => {
    const exampleSet = new Set(exampleParsed.keys);
    const missing = schemaKeys.filter((k) => !exampleSet.has(k) && !OPTIONAL_ENV_KEYS.has(k));
    expect(
      missing,
      `这些 key 在 src/config.ts 里会被读，但 .env.example 里没有 —— 补进去：\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it.skipIf(!envExists)('代码会读的 key 都在 .env 里（除了 7 个登记的例外）', () => {
    const envSet = new Set(envParsed.keys);
    const missing = schemaKeys.filter((k) => !envSet.has(k) && !OPTIONAL_ENV_KEYS.has(k));
    expect(
      missing,
      `这些 key 在 src/config.ts 里会被读，但 .env 里没有 —— 补进去：\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('7 个例外的 key 确实不在两个文件里（钉住这个约定）', () => {
    // 例外要么被加进文件（那就该从例外清单里删掉），要么就不该出现在文件里。
    // 这里守的是「例外清单跟文件不会各说各话」。
    for (const key of OPTIONAL_ENV_KEYS) {
      expect(
        exampleParsed.keys.includes(key),
        `${key} 在 OPTIONAL_ENV_KEYS 里（故意不写进模板），但它出现在 .env.example 里了 —— ` +
          '二选一：把它从例外清单里删掉，或者从 .env.example 里删掉',
      ).toBe(false);
    }
  });

  it('例外清单本身没被悄悄改大', () => {
    // 例外清单是「白名单」—— 每多一个，就多一个可以绕过检查的洞。
    expect(OPTIONAL_ENV_KEYS.size).toBe(7);
  });
});
