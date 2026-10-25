import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * 租户隔离的**架构约束测试** —— docs/12-a-需求-多租户与登录.md §A1
 *
 * ## 为什么是测试而不是 lint
 *
 * A1 的验收原文：「直接 `Document.findAll()`（不带 scope）应该有警告或被 lint 禁止」。
 * ⚠️ 本项目的 `yarn lint` 现在**跑不起来**（typescript-eslint 不支持 TypeScript 7，
 * 在加载配置阶段就退出）—— 所以「靠 lint 拦」这条路暂时是断的。
 * 既然如此，就用项目已有的另一条约定来兜：**D6 的测试基建契约**
 * —— 用一个会失败的测试来表达「这条规矩不许破」。
 *
 * ## 它拦什么
 *
 * 租户级模型（User / Session / Message / Document / …）的查询**必须带租户过滤**。
 * 忘了加 = 跨租户数据泄露，而且这种 bug 在功能测试里很难被发现
 * （每个测试都用自己的租户，串了也看不出来）。
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

/** 租户级模型 —— 它们的查询必须带租户过滤 */
const TENANT_SCOPED_MODELS = [
  'User',
  'Session',
  'Message',
  'Document',
  'TenantModel',
  'UserMemory',
  'CostLog',
  'EvaluationDataset',
  'EvaluationItem',
  'EvaluationRun',
  'EvaluationResult',
  'Trace',
  'Span',
  'PromptVersion',
  'ApiKey',
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
    reason: 'prefix 粗筛故意跨租户：key_prefix 只有 8 位（前缀 + 5 位随机），不足以定位唯一一把钥匙，所以先捞候选再逐个 bcrypt 比对 —— 真正确定归属的是 bcrypt 比对结果',
  },
  {
    file: 'src/lib/api-key-auth.ts',
    snippet: 'ApiKey.update(',
    reason: '更新 last_used_at —— 这一行是刚用 prefix + bcrypt 比对命中的那把 key',
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
];

/** 递归列出 src/ 下的 .ts 文件 */
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

describe('租户隔离 · 架构约束（docs/12-a §A1）', () => {
  const files = listTsFiles(SRC_DIR);

  it('扫得到源码（别让测试因为路径写错而空跑）', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('租户级模型的每个查询都带租户过滤（或已登记为例外）', () => {
    const modelPattern = new RegExp(
      `\\b(?:${TENANT_SCOPED_MODELS.join('|')})\\.(?:findAll|findOne|findByPk|count|sum|aggregate|destroy|update)\\s*\\(`,
      'g',
    );
    const violations: string[] = [];

    for (const abs of files) {
      const rel = path.relative(path.resolve(SRC_DIR, '..'), abs);
      const src = readFileSync(abs, 'utf8');
      let m: RegExpExecArray | null;
      modelPattern.lastIndex = 0;
      while ((m = modelPattern.exec(src)) !== null) {
        const callStart = m.index;
        const openParen = src.indexOf('(', callStart);
        const callEnd = matchCallEnd(src, openParen);
        const callText = src.slice(callStart, callEnd + 1);
        if (callText.includes('tenant_id')) {
          continue;
        }
        // 登记过的例外
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
