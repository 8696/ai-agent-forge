/**
 * `.env` / `.env.example` 的**结构契约**
 *
 * 单独抽一个模块放「约定」，是因为它有两处消费者：
 *  - `scripts/sync-env.ts` —— 给开发者的命令行工具（改文件时跑）
 *  - `tests/unit/env-consistency.test.ts` —— CI 上的守卫测试
 *
 * 两处各写一份清单 → 早晚有一处忘了改 → 约定就作废了。
 *
 * ## 契约本身
 *
 *  - **`.env.example` 是结构模板**（唯一真源）：同一组 key、同一顺序、同一段注释
 *  - `.env` = 模板结构 + 本地真值
 *  - 值的差异：
 *      - `*_API_KEY` / `*_PASSWORD` / `*_SECRET`：`.env` 写真值，`.env.example` 留空
 *      - 其他：`.env.example` 是本地默认；`.env` 可以是 dev override（远程 MySQL / 切 provider）
 */

/** 一行 `KEY=value` */
export const KV_LINE = /^([A-Z_][A-Z0-9_]*)=(.*)$/;

/** 哪些 key 算「密钥」—— 这些在 `.env.example` 里必须留空 */
export const SECRET_KEY = /KEY|SECRET|PASSWORD/;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

/**
 * **故意不写进 `.env` / `.env.example` 的 key**
 *
 * 判定依据是 `src/config.ts` 的 `envSchema` —— 只有它读到的变量才算数。
 * 下面这 7 个是有意排除的：
 *
 *  - 6 个 `CHAT_*`：已经搬到租户后台「租户设置」里配了（docs/12-c §C4），
 *    平台级默认值写在 `src/config.ts` 里；真要批量改全平台默认值，
 *    把对应的键加回模板即可（租户没覆盖的项会走那里的值）。
 *  - `QDRANT_COLLECTION`：默认 `documents`，绝大多数部署不用改；
 *    要改就在 `.env` 里加一行 —— 但**别加进模板**，否则改了一处就跟着改全局。
 *
 * ⚠️ 这个清单是「白名单」：**不在这里面的每一个 `envSchema` key 都必须出现在两个 env 文件里**。
 */
export const OPTIONAL_ENV_KEYS: ReadonlySet<string> = new Set([
  'CHAT_CONTEXT_TOKEN_BUDGET',
  'CHAT_MAX_HISTORY_TURNS',
  'CHAT_RETRIEVAL_TOKEN_BUDGET',
  'CHAT_RETRIEVAL_TOP_K',
  'CHAT_MAX_INPUT_CHARS',
  'CHAT_THINKING_BUDGET_TOKENS',
  'QDRANT_COLLECTION',
]);

export interface ParsedEnv {
  /** 按出现顺序的 key 列表（重复 key 会被去重，重复由调用方另查） */
  keys: string[];
  /** key → 值 */
  values: Map<string, string>;
}

/** 解析 env 文件内容：抽出 key 顺序 + 值 */
export function parseEnvContent(content: string): ParsedEnv {
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
 * **结构指纹**：把值抹掉、只留 key 和注释。
 *
 * 两个文件的指纹逐行相等 == key 集合相同 + 顺序相同 + 注释逐行相同。
 * 这是「结构一致」这一条的完整判定 —— 只比 key 集合会漏掉「顺序不同」和「注释不同」。
 *
 * ⚠️ **行尾注释要留着**：`KEY=8000 # 自己加的` 里 `#` 后面那段是注释不是值。
 * 一起抹掉的话两边就长得一样了，但 `.env` 里那个 key 的实际值会变成
 * `8000 # 自己加的`（zod 校验直接挂）。
 */
export function structuralFingerprint(content: string): string[] {
  return content.split('\n').map((line) => {
    const m = line.match(KV_LINE);
    if (!m || m[1] === undefined) return line;
    const rest = m[2] ?? '';
    const hashIdx = rest.indexOf('#');
    const trailing = hashIdx === -1 ? '' : rest.slice(hashIdx);
    return `${m[1]}=${trailing}`;
  });
}

/**
 * 从 `src/config.ts` 的 `envSchema` 里抽出**代码真正会读**的环境变量名。
 *
 * ⚠️ 用正则抠源码是「够用就好」的做法 —— 比 import `src/config.ts` 安全
 * （import 会有 dotenv + 校验 + `process.exit` 的副作用，测试里不能碰）。
 * 代价是：`envSchema` 里将来如果出现嵌套对象，这里会认错 ——
 * 所以调用方要断言抽出来的 key 数量在一个合理区间（见守卫测试）。
 */
export function schemaEnvKeys(configSrc: string): string[] {
  const start = configSrc.indexOf('const envSchema');
  if (start === -1) throw new Error('src/config.ts 里找不到 envSchema');
  const end = configSrc.indexOf('\nconst parsed', start);
  const body = end === -1 ? configSrc.slice(start) : configSrc.slice(start, end);
  const keys = [...body.matchAll(/^ {2}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1] as string);
  return [...new Set(keys)];
}
