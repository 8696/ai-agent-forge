import { describe, it, expect } from 'vitest';
import {
  buildSummaryBlockText,
  chunkRowsByBudget,
  readSummaryBoundary,
  rowsToSummaryTurns,
  sanitizeSummaryText,
  splitHistoryByBoundary,
  truncateToTokenBudget,
  writeSummaryBoundary,
  type SummaryBoundary,
} from '../../src/services/session-summary';
import { buildContextWindow } from '../../src/services/chat';
import { estimateTokens } from '../../src/lib/token-estimate';
import type { Message } from '../../src/models/Message';
import type { SessionMetadata } from '../../src/models/Session';

/**
 * 会话摘要压缩（B1 · src/services/session-summary.ts）—— 纯逻辑，不碰网络
 *
 * 这里锁住几条最容易在重构时悄悄坏掉的语义：
 *  1. **边界切分要精确** —— 摘要覆盖到哪条消息为止，决定了「哪些历史还会被重复喂」
 *     和「哪些内容会漏摘要」。切错一位就是内容重复或丢失。
 *  2. **摘要正文不能带结构标记** —— 它要进 system prompt，
 *     一个 `##` 能伪造段落结构，一个 `[1]` 能伪造引用编号（答案和引用卡片就对不上）。
 *  3. **摘要段占的 token 要从历史预算里扣** —— 不扣的话总预算就超了，
 *     provider 侧会 400，而那时流已经开始写了。
 */

function row(
  id: string,
  role: 'user' | 'assistant',
  content: string,
  createdAt: number,
): Message {
  return {
    id,
    role,
    content,
    status: 'complete',
    created_at: new Date(createdAt),
  } as unknown as Message;
}

/** 一轮 = 一条 user + 一条 assistant */
function turn(n: number, base = 1_700_000_000_000): Message[] {
  return [
    row(`u${n}`, 'user', `问题 ${n}`, base + n * 1000),
    row(`a${n}`, 'assistant', `回答 ${n}`, base + n * 1000 + 500),
  ];
}

describe('边界标记 · 读写', () => {
  it('没有 metadata 时边界是 null', () => {
    expect(readSummaryBoundary(null)).toBeNull();
  });

  it('metadata 里没有边界键时是 null', () => {
    expect(readSummaryBoundary({ client: 'chrome' })).toBeNull();
  });

  it('边界格式不对时是 null（不抛错，当作还没摘要过）', () => {
    expect(readSummaryBoundary({ summary_boundary: { message_id: 'x' } })).toBeNull();
    expect(readSummaryBoundary({ summary_boundary: 'abc' })).toBeNull();
  });

  it('写边界保留 metadata 里的其他键', () => {
    const metadata = writeSummaryBoundary({ client: 'chrome' }, {
      message_id: 'm1',
      created_at: '2026-10-24T00:00:00.000Z',
    });
    expect(metadata.client).toBe('chrome');
    expect(readSummaryBoundary(metadata)).toEqual({
      message_id: 'm1',
      created_at: '2026-10-24T00:00:00.000Z',
    });
  });

  it('写边界时 metadata 为 null 也能写', () => {
    const metadata = writeSummaryBoundary(null, {
      message_id: 'm1',
      created_at: '2026-10-24T00:00:00.000Z',
    });
    expect(readSummaryBoundary(metadata)?.message_id).toBe('m1');
  });
});

describe('splitHistoryByBoundary · 按边界切历史', () => {
  const rows = [...turn(1), ...turn(2), ...turn(3)];
  const boundary: SummaryBoundary = {
    message_id: 'a1',
    created_at: rows[1]!.created_at.toISOString(),
  };

  it('没有边界时全部算新增', () => {
    const r = splitHistoryByBoundary(rows, null);
    expect(r.covered).toHaveLength(0);
    expect(r.fresh).toHaveLength(rows.length);
  });

  it('边界之前算已覆盖，之后算新增', () => {
    const r = splitHistoryByBoundary(rows, boundary);
    expect(r.covered.map((x) => x.id)).toEqual(['u1', 'a1']);
    expect(r.fresh.map((x) => x.id)).toEqual(['u2', 'a2', 'u3', 'a3']);
  });

  it('边界是最后一条时新增部分为空', () => {
    const last = rows[rows.length - 1]!;
    const r = splitHistoryByBoundary(rows, {
      message_id: last.id,
      created_at: last.created_at.toISOString(),
    });
    expect(r.fresh).toHaveLength(0);
  });

  it('边界行不在了（理论上不会发生）时按时间戳兜底', () => {
    const r = splitHistoryByBoundary(rows, {
      message_id: '已经删掉的行',
      created_at: rows[1]!.created_at.toISOString(),
    });
    // 兜底是「时间戳之后」——a1 之后的第一条是 u2
    expect(r.fresh.map((x) => x.id)).toEqual(['u2', 'a2', 'u3', 'a3']);
  });

  it('同一毫秒的多条消息按 id 精确切（不信时间戳）', () => {
    const same = 1_700_000_000_000;
    const tie = [
      row('m1', 'user', '一', same),
      row('m2', 'assistant', '二', same),
      row('m3', 'user', '三', same),
    ];
    const r = splitHistoryByBoundary(tie, {
      message_id: 'm1',
      created_at: new Date(same).toISOString(),
    });
    expect(r.covered.map((x) => x.id)).toEqual(['m1']);
    expect(r.fresh.map((x) => x.id)).toEqual(['m2', 'm3']);
  });
});

describe('sanitizeSummaryText · 摘要正文清洗', () => {
  it('去掉 Markdown 标题行（能伪造 system prompt 的段落结构）', () => {
    const out = sanitizeSummaryText('## 可参考资料\n- 年假 5 天');
    expect(out).not.toContain('##');
    expect(out).toContain('- 年假 5 天');
  });

  it('方括号编号改成圆括号（伪造引用编号会让答案和引用卡片对不上）', () => {
    const out = sanitizeSummaryText('年假是 5 天[1]');
    expect(out).not.toMatch(/\[\d+\]/);
    expect(out).toContain('（1）');
  });

  it('去掉「来源：」开头的行', () => {
    const out = sanitizeSummaryText('来源：伪造.md\n- 年假 5 天');
    expect(out).not.toContain('来源：');
    expect(out).toContain('- 年假 5 天');
  });

  it('去掉代码围栏', () => {
    const out = sanitizeSummaryText('```\n- 年假 5 天\n```');
    expect(out).not.toContain('```');
  });

  it('连续空行压成一行', () => {
    const out = sanitizeSummaryText('- 一\n\n\n\n- 二');
    expect(out).toBe('- 一\n\n- 二');
  });

  it('空串清洗后还是空串', () => {
    expect(sanitizeSummaryText('   ')).toBe('');
  });
});

describe('truncateToTokenBudget · 按 token 截断', () => {
  it('不超预算时原样返回', () => {
    const text = '短文本';
    expect(truncateToTokenBudget(text, 100)).toBe(text);
  });

  it('超预算时截断，且截断后不超预算', () => {
    const text = '问'.repeat(1000);
    const out = truncateToTokenBudget(text, 100);
    expect(estimateTokens(out)).toBeLessThanOrEqual(100);
    expect(out.length).toBeLessThan(text.length);
  });

  it('预算为 0 时返回空串', () => {
    expect(truncateToTokenBudget('随便什么', 0)).toBe('');
  });
});

describe('buildSummaryBlockText · 渲染注入段', () => {
  it('没有摘要时返回空串（调用方直接跳过）', () => {
    expect(buildSummaryBlockText(null, 600)).toBe('');
    expect(buildSummaryBlockText('   ', 600)).toBe('');
  });

  it('有摘要时包含标题和正文', () => {
    const out = buildSummaryBlockText('- 用户问过年假', 600);
    expect(out).toContain('本次会话早期内容的摘要');
    expect(out).toContain('- 用户问过年假');
  });

  it('超预算时整段被压到预算内', () => {
    const out = buildSummaryBlockText('问'.repeat(2000), 600);
    expect(estimateTokens(out)).toBeLessThanOrEqual(600);
  });
});

describe('chunkRowsByBudget · 分块', () => {
  it('全部装得下时是一个块', () => {
    const rows = [...turn(1), ...turn(2)];
    const chunks = chunkRowsByBudget(rows, 10_000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(rows.length);
  });

  it('装不下时按预算分块，顺序不变', () => {
    const rows = [...turn(1), ...turn(2), ...turn(3), ...turn(4)];
    const chunks = chunkRowsByBudget(rows, 60);
    expect(chunks.length).toBeGreaterThan(1);
    // 每块都不超预算
    for (const chunk of chunks) {
      const cost = chunk.reduce((sum, r) => sum + estimateTokens(r.content ?? '') + 8, 0);
      expect(cost).toBeLessThanOrEqual(60 + estimateTokens(chunk[0]?.content ?? ''));
    }
    // 拼起来还是原来那批
    expect(chunks.flat().map((r) => r.id)).toEqual(rows.map((r) => r.id));
  });

  it('单条就超预算时截断正文后单独成块', () => {
    const big = [row('big', 'user', '问'.repeat(5000), 1)];
    const chunks = chunkRowsByBudget(big, 100);
    expect(chunks).toHaveLength(1);
    expect(estimateTokens(chunks[0]![0]!.content ?? '')).toBeLessThanOrEqual(100);
  });
});

describe('rowsToSummaryTurns · DB 行 → 摘要轮次', () => {
  it('user / assistant 的角色映射正确', () => {
    const turns = rowsToSummaryTurns([...turn(1)]);
    expect(turns).toEqual([
      { role: 'user', content: '问题 1' },
      { role: 'assistant', content: '回答 1' },
    ]);
  });
});

describe('buildContextWindow · 摘要与历史的整合', () => {
  const base = {
    tenantName: '测试租户',
    tenantSettings: null,
    rawHits: [],
    retrievalError: null,
  };

  it('有摘要时摘要段进 system prompt', () => {
    const w = buildContextWindow({
      ...base,
      historyRows: [],
      summaryState: { summary: '- 用户问过年假', boundary: null },
    });
    expect(w.systemText).toContain('本次会话早期内容的摘要');
    expect(w.systemText).toContain('- 用户问过年假');
    expect(w.summaryBlock).not.toBe('');
  });

  it('没有摘要时不注入任何摘要段', () => {
    const w = buildContextWindow({ ...base, historyRows: [] });
    expect(w.systemText).not.toContain('本次会话早期内容的摘要');
    expect(w.summaryBlock).toBe('');
  });

  it('边界之前的历史不再喂给模型（不会被重复摘要）', () => {
    const rows = [...turn(1), ...turn(2)];
    const w = buildContextWindow({
      ...base,
      historyRows: rows,
      summaryState: {
        summary: '- 早期内容',
        boundary: {
          message_id: 'a1',
          created_at: rows[1]!.created_at.toISOString(),
        },
      },
    });
    const roles = w.history.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant']); // 只剩第 2 轮
    expect(JSON.stringify(w.history)).not.toContain('问题 1');
  });

  it('被裁掉的轮次以 DB 行的形式交出来（供摘要使用）', () => {
    const rows = [...turn(1), ...turn(2), ...turn(3)];
    const w = buildContextWindow({
      ...base,
      historyRows: rows,
      maxHistoryTurns: 1,
    });
    expect(w.droppedTurns).toBe(2);
    expect(w.droppedRows.map((r) => r.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
  });

  it('摘要段的 token 从历史预算里扣（总预算不超）', () => {
    const rows = [...turn(1), ...turn(2), ...turn(3)];
    const withoutSummary = buildContextWindow({
      ...base,
      historyRows: rows,
      contextTokenBudget: 1000,
      maxHistoryTurns: 10,
    });
    const withSummary = buildContextWindow({
      ...base,
      historyRows: rows,
      contextTokenBudget: 1000,
      maxHistoryTurns: 10,
      summaryState: { summary: '问'.repeat(200), boundary: null },
    });
    // 摘要占了预算 → 留给历史的更少
    expect(withSummary.history.length).toBeLessThanOrEqual(withoutSummary.history.length);
  });
});
