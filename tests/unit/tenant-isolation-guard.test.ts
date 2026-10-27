import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * 租户隔离的**架构约束测试** —— docs/12-a-需求-多租户与登录.md §A1
 *
 * ## 三条防线（缺一不可）
 *
 *   1. **运行时强制**（`src/lib/tenant-scope.ts`）：请求级租户上下文 + Sequelize 全局钩子，
 *      查询发出前自动补 `tenant_id` 过滤 —— 忘了加也不会跨租户。
 *   2. **本测试**：静态扫描源码，拦下**运行时兜不住**的情况：
 *      - 查询的 where 形状让钩子插不进去（数组 where / 顶层 `Op.or`）
 *      - 查询写死了租户 id（`tenant_id: 'acme'`）
 *      - 查询的 where 完全不带租户锚点（白名单要登记理由）
 *   3. **代码评审**：判断「这条查询本来就不该带租户过滤」——登记到白名单并写清理由。
 *
 * ## 为什么不用 lint
 *
 * A1 的验收原文：「直接 `Document.findAll()`（不带 scope）应该有警告或被 lint 禁止」。
 * ⚠️ 本项目的 `yarn lint` 现在**跑不起来**（typescript-eslint 不支持 TypeScript 7，
 * 在加载配置阶段就退出）—— 「靠 lint 拦」这条路是断的，
 * 就用项目已有的另一条约定来兜：**D6 的测试基建契约**。
 *
 * ## 例外怎么写
 *
 * 有些查询**故意**不带 tenant_id —— 因为它们的作用域是「已经校验过归属的父级」：
 *   - `where: { session_id }` —— session 的归属在调用前已校验（loadOwnedSession）
 *   - `where: { id }` —— 那一行的归属在查出来时已校验
 *   - `where` 由 helper 拼出来（helper 内部注入了 tenant_id）
 * 这些必须逐条登记在下面的白名单里，**并写清理由** ——
 * 白名单是「例外登记表」，不是「黑名单」，每加一条都要有人能解释。
 */

const SRC_DIR = path.resolve(__dirname, '../../src');
const MODELS_DIR = path.resolve(SRC_DIR, 'models');

/**
 * 租户级模型的**查询方法**清单。
 *
 * ⚠️ 宁可多列也不要漏 —— 漏一个方法名 = 漏扫整类查询。
 *   `findAndCountAll` / `bulkCreate` 都曾经漏过（2026-10-25 审计发现）。
 */
const QUERY_METHODS = [
  'findAll',
  'findOne',
  'findByPk',
  'findAndCountAll',
  'findOrCreate',
  'count',
  'sum',
  'aggregate',
  'update',
  'destroy',
  'bulkCreate',
];

/**
 * 故意不带 tenant_id 的查询点（每条都要有理由）。
 *
 * ⚠️ 加新条目时先问一句：**这条查询真的不会跨租户吗？**
 *    答不上来就别加 —— 去把 tenant_id 加上。
 */
const ALLOWED_NO_TENANT_FILTER: Array<{
  file: string;
  /** 用来定位的代码片段（单行，出现在调用点附近即可） */
  snippet: string;
  reason: string;
}> = [
  {
    file: 'src/gateway/admin/auth-routes.ts',
    snippet: 'User.findByPk(u.sub)',
    reason: '紧接着就校验 `user.tenant_id !== u.tenant_id`，不一致直接 401 —— 主键来自已验签的 JWT，租户过滤放在代码里判',
  },
  {
    file: 'src/gateway/customer/auth-routes.ts',
    snippet: 'User.findByPk(u.sub)',
    reason: '同上（customer 子系统的 /me 与 /change-password）',
  },
  {
    file: 'src/gateway/customer/chat-routes.ts',
    snippet: 'Message.update(',
    reason: '按消息主键改反馈 —— 那一行的归属在前面已通过「会话 + 消息」双重校验',
  },
  {
    file: 'src/lib/api-key-auth.ts',
    snippet: 'ApiKey.findAll({',
    reason:
      '存量 key 的慢路径粗筛故意跨租户：key_prefix 只有 8 位（前缀 + 5 位随机），' +
      '不足以定位唯一一把钥匙，所以先捞候选再逐个 bcrypt 比对 —— ' +
      '真正确定归属的是 bcrypt 比对结果。' +
      '（新 key 走的是上面那条 sha256 快路径，不经过这里）',
  },
  {
    file: 'src/lib/api-key-auth.ts',
    snippet: 'ApiKey.findOne({',
    reason:
      'sha256 精确命中 —— 这一步**故意跨租户**：租户上下文是 verify 成功之后才设的' +
      '（runWithTenant 在 apiKeyAuth 里），此刻还不知道这把 key 属于哪个租户。' +
      '归属由「sha256 唯一索引」+「bcrypt 比对」双重确定',
  },
  {
    file: 'src/lib/api-key-auth.ts',
    snippet: 'ApiKey.update(',
    reason:
      '两处：① 更新 last_used_at —— 那一行是刚比对命中的那把 key；' +
      '② 回填存量 key 的 key_sha256 —— 同样只按 id 命中刚比对成功的那一行',
  },
  {
    file: 'src/services/chat.ts',
    snippet: 'where: { session_id: { [Op.in]: rows.map((r) => r.id) } },',
    reason: '会话列表的「消息条数 + 最后消息时间」—— session_id 来自本租户已过滤的会话列表',
  },
  {
    file: 'src/services/chat.ts',
    snippet: 'content: patch.content,',
    reason: '收尾助手消息 —— 按主键改，行的归属在写入时已确定',
  },
  {
    file: 'src/services/chat.ts',
    snippet: "{ status: 'failed' },",
    reason: '僵尸 streaming 行自愈 —— 按 session_id 限定，session 归属已校验',
  },
  {
    file: 'src/services/chat.ts',
    snippet: '...(excludeIds.length > 0 ? { id: { [Op.notIn]: excludeIds } } : {}),',
    reason: '取会话历史 —— session_id 的归属在调用方已校验（loadOwnedSession）',
  },
  {
    file: 'src/services/chat.ts',
    snippet: 'where: { session_id: sessionId },',
    reason: '读历史消息 —— 同上，session 归属已校验',
  },
  {
    file: 'src/services/evaluation.ts',
    snippet: 'prompt_version: resolvedPrompt.version,',
    reason: '跑批开始时更新 —— 按 runId，run 是本次跑批自己建的',
  },
  {
    file: 'src/services/evaluation.ts',
    snippet: 'completed_items: scored.length,',
    reason: '更新跑批进度 —— 同上',
  },
  {
    file: 'src/services/evaluation.ts',
    snippet: "status: 'failed',",
    reason: '跑批失败落状态 —— 同上',
  },
  {
    file: 'src/services/memory.ts',
    snippet: 'UserMemory.findAll({',
    reason: 'where 由 buildMemoryWhere(tenantId, ...) 拼出来 —— tenant_id 在 helper 里注入',
  },
  {
    file: 'src/services/memory.ts',
    snippet: 'UserMemory.count({ where })',
    reason: '同上（记忆计数跟列表共用同一个 where）',
  },
  {
    file: 'src/services/memory-relevance.ts',
    snippet: "UserMemory.findOne({ where: { embedding_model: '__probe__' }",
    reason:
      '启动时的**列存在性探针**（迁移 035 没跑时的降级判定）。' +
      '① 用的是永不命中的哨兵值 `__probe__`，取不到任何真实行；' +
      '② 只 select `id` 当布尔用（判断「查询有没有因缺列而报错」），**不返回任何租户数据**；' +
      '③ 它跑在**任何请求上下文之外**（进程启动时），租户作用域钩子此时没有租户可补。' +
      '⚠️ 缺列时 `embedding_model` 本身也在 WHERE 里 → 查询会报 Unknown column → 探针才检测得到',
  },
  {
    file: 'src/services/document-chunks.ts',
    snippet: 'DocumentChunk.count()',
    reason:
      '启动时的**表存在性探针**（迁移 036 没跑时的降级判定）。' +
      '① 它跑在**任何请求上下文之外**（进程启动时），租户作用域钩子此时没有租户可补；' +
      '② 它只做 count 判表在不在，**不返回任何租户数据**；' +
      '③ 探针的返回值只决定「切片编辑功能要不要开放」，不参与任何业务判断。',
  },
  {
    file: 'src/services/chat.ts',
    snippet: "Message.findOne({ where: { favorite: false }, attributes: ['id'] })",
    reason:
      '启动时的**列存在性探针**（迁移 037 没跑时的降级判定）。' +
      '① 只 select `id` 当布尔用（判断「查询有没有因缺列而报错」），**不返回任何租户数据**；' +
      '② 它跑在**任何请求上下文之外**（进程启动时），租户作用域钩子此时没有租户可补；' +
      '③ 探针的返回值只决定「消息级收藏要不要开放」，不参与任何业务判断。' +
      '⚠️ 缺列时 `favorite` 本身也在 WHERE 里 → 查询会报 Unknown column → 探针才检测得到',
  },
  // ---- 平台方视角的跨租户查询（docs/04-d §6.1「/system/audit 也能查」）----
  {
    file: 'src/lib/audit-log.ts',
    snippet: 'AuditLog.findAndCountAll({',
    reason:
      'listAllAuditLogs —— **平台方视角，故意跨租户**。它只在 system 命名空间被调用，' +
      '那边**没有租户上下文**，所以租户作用域钩子不会补过滤。' +
      '租户 admin 走的是 listAuditLogs（强制带 tenant_id），两条路完全分开。',
  },
  {
    file: 'src/lib/audit-log.ts',
    snippet: 'User.findAll({',
    reason:
      'resolveUserEmailsAcrossTenants —— 同上：平台方查审计日志时要解析**各个租户**的' +
      '操作者邮箱，按 id 批量查（租户账号在 users 表，平台方账号在 system_users 表）。',
  },
  {
    file: 'src/lib/audit-log.ts',
    snippet: 'AuditLog.findAll({',
    reason:
      'listAllAuditActions —— 同上：平台方的「操作类型」筛选清单，跨租户统计 action。',
  },
];

/** 递归列出目录下的 .ts 文件 */
function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 剥掉注释，只留代码。
 *
 * ⚠️ 为什么必须剥：这份测试扫的是**源码文本**，不是 AST。
 *    文档注释里引用一句 `Document.findAll()` 就会被当成一次查询（2026-10-25 真踩过）。
 *
 * 剥的时候要认字符串字面量 —— 否则 `'https://x'` 里的 `//` 会被当成行注释，
 * 把后面一整行代码吃掉（那才是真的制造假阴性）。
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      const start = i;
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      // 用等量的换行 + 空格替掉 —— 保持行号不变（报错信息里的行号才对得上）
      const removed = src.slice(start, Math.min(i, n));
      out += removed.replace(/[^\n]/g, ' ');
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < n) {
        if (src[i] === '\\') {
          out += src[i] + (src[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += src[i];
        if (src[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * 租户级模型清单 —— **从模型源码自动推导**，不手写。
 *
 * ⚠️ 之前是手写 17 个模型，结果漏了 `TenantSetting`（它有 tenant_id 列），
 *    那个模型的 4 处查询从来没被扫过（2026-10-25 审计发现）。
 *    改成自动推导以后：新增模型只要有 tenant_id 列，就自动进清单 —— 漏登记不可能发生。
 */
function tenantScopedModels(): string[] {
  const names: string[] = [];
  for (const file of listTsFiles(MODELS_DIR)) {
    const src = readFileSync(file, 'utf8');
    if (!/declare\s+tenant_id\s*:/.test(src)) {
      continue;
    }
    const m = /export class\s+([A-Za-z0-9_]+)\s+extends\s+Model/.exec(src);
    if (m !== null && m[1] !== undefined) {
      names.push(m[1]);
    }
  }
  return names.sort();
}

/** 找到调用表达式结束的位置（括号配平） */
function matchCallEnd(src: string, openParenIndex: number): number {
  let depth = 0;
  for (let i = openParenIndex; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return src.length;
}

/** where 里有没有 tenant_id 这个**键**（而不是随便出现这个词） */
function whereHasTenantKey(callText: string): boolean {
  return /\btenant_id\s*:/.test(callText);
}

/** 找到配平的 `}`（从 openBraceIndex 开始） */
function matchBrace(src: string, openBraceIndex: number): number {
  let depth = 0;
  for (let i = openBraceIndex; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return src.length;
}

/**
 * where 是不是一个变量（`{ where, ... }` 或 `{ where: someVar }`）——
 * 是的话，回溯到它在本文件里的定义，看定义里有没有 tenant_id。
 *
 * ⚠️ 为什么要回溯：调用点写的是 `where`（一个变量名），
 *    真正的过滤条件在几行之上的 `const where = { tenant_id: tenantId, ... }` 里。
 *    找不到这个定义就当「没有租户过滤」—— 宁可误报（逼人登记白名单），不可漏报。
 */
function whereFromVariableHasTenantKey(
  fileSrc: string,
  callStart: number,
  callText: string,
): boolean {
  // `where: someVar`（允许 `as` 类型断言：`where: where as WhereOptions<T>`）
  const inline = /\bwhere\s*:\s*([A-Za-z_$][\w$]*)\b/.exec(callText);
  // 简写 `{ where, ... }`
  const shorthand = /[{,]\s*where\s*[,}]/.test(callText);
  const varName = inline !== null ? inline[1] : shorthand ? 'where' : null;
  if (varName === null) {
    return false;
  }
  // 在调用点之前找该变量**最近一次**的声明
  const before = fileSrc.slice(0, callStart);
  const decl = new RegExp(`\\b(?:const|let|var)\\s+${varName}\\b[^=;]*=\\s*\\{`, 'g');
  let match: RegExpExecArray | null;
  let lastDecl = -1;
  let lastBodyStart = -1;
  while ((match = decl.exec(before)) !== null) {
    lastDecl = match.index;
    lastBodyStart = match.index + match[0].length - 1;
  }
  if (lastDecl < 0 || lastBodyStart < 0) {
    return false;
  }
  // 只看这个对象字面量自己的内容（到配平的 } 为止），不看它后面的代码
  const bodyEnd = matchBrace(before, lastBodyStart);
  const bodyText = before.slice(lastBodyStart, bodyEnd + 1);
  return /\btenant_id\s*:/.test(bodyText);
}

describe('租户隔离 · 架构约束（docs/12-a §A1）', () => {
  const files = listTsFiles(SRC_DIR);
  const models = tenantScopedModels();

  it('扫得到源码（别让测试因为路径写错而空跑）', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('租户级模型清单推导得出来（自动扫描 src/models）', () => {
    // 推导不出来 = 模型文件结构变了，测试会变成空跑
    expect(models.length).toBeGreaterThanOrEqual(15);
    // 之前手写清单漏过的那个
    expect(models).toContain('TenantSetting');
  });

  it('租户级模型的每个查询都带租户过滤（或已登记为例外）', () => {
    const modelPattern = new RegExp(
      `\\b(?:${models.join('|')})\\.(?:${QUERY_METHODS.join('|')})\\s*\\(`,
      'g',
    );
    const violations: string[] = [];

    for (const abs of files) {
      const rel = path.relative(path.resolve(SRC_DIR, '..'), abs);
      const raw = readFileSync(abs, 'utf8');
      // 剥掉注释再扫 —— 文档里引用一句 `Document.findAll()` 不算一次查询
      const src = stripComments(raw);
      let m: RegExpExecArray | null;
      modelPattern.lastIndex = 0;
      while ((m = modelPattern.exec(src)) !== null) {
        const callStart = m.index;
        const openParen = src.indexOf('(', callStart);
        const callEnd = matchCallEnd(src, openParen);
        const callText = src.slice(callStart, callEnd + 1);

        if (whereHasTenantKey(callText)) {
          // 写死了租户 id —— 这是跨租户查询的种子（'acme' 会被换成别的租户也照样跑）
          const literal = /\btenant_id\s*:\s*['"`][^'"`]+['"`]/.exec(callText);
          if (literal !== null) {
            violations.push(
              `${rel}:${src.slice(0, callStart).split('\n').length}  ${m[0]} —— ` +
                `tenant_id 写死了字面量（${literal[0]}）。租户 id 必须来自上下文，不能写死。`,
            );
          }
          continue;
        }
        if (whereFromVariableHasTenantKey(src, callStart, callText)) {
          continue;
        }
        // 登记过的例外
        // ⚠️ 窗口要用**剥离后**的 src —— callStart 是剥离后源码里的下标，
        //    拿它去切原文会错位（注释被剥掉后字符数变了）。
        const nearby = src.slice(Math.max(0, callStart - 40), callStart + 420);
        const allowed = ALLOWED_NO_TENANT_FILTER.some(
          (a) => rel.endsWith(a.file) && nearby.includes(a.snippet),
        );
        if (allowed) {
          continue;
        }
        const line = src.slice(0, callStart).split('\n').length;
        violations.push(
          `${rel}:${line}  ${m[0]}\n` +
            '    → 这条查询没有租户过滤。要么加上 tenant_id，' +
            '要么确认它确实不会跨租户，然后登记到 ALLOWED_NO_TENANT_FILTER（要写清理由）。',
        );
      }
    }

    expect(violations, `发现 ${violations.length} 处没有租户过滤的查询：\n${violations.join('\n')}`).toEqual(
      [],
    );
  });

  it('白名单里的每条都还能在源码里找到（别留过期条目）', () => {
    const stale: string[] = [];
    for (const a of ALLOWED_NO_TENANT_FILTER) {
      const abs = path.resolve(SRC_DIR, '..', a.file);
      let src = '';
      try {
        src = readFileSync(abs, 'utf8');
      } catch {
        stale.push(`${a.file} —— 文件不存在了`);
        continue;
      }
      if (!src.includes(a.snippet)) {
        stale.push(`${a.file} —— 找不到片段：${a.snippet.slice(0, 40)}`);
      }
      if (a.reason.trim() === '') {
        stale.push(`${a.file} —— 缺理由`);
      }
    }
    expect(stale, `白名单有过期条目：\n${stale.join('\n')}`).toEqual([]);
  });
});
