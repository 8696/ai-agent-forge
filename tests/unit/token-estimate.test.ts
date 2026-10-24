import { describe, it, expect } from 'vitest';
import {
  estimateTokens,
  estimateMessagesTokens,
  fitHistoryToBudget,
  fitHitsToBudget,
  MESSAGE_OVERHEAD_TOKENS,
  type TokenCountableMessage,
} from '../../src/lib/token-estimate';

/**
 * token 估算 + 上下文预算裁剪（src/lib/token-estimate.ts）—— 纯函数，不碰网络
 *
 * 这里锁住几条最容易在重构时悄悄坏掉的语义：
 *  1. 估算是**故意高估**的 —— 估多了只是多裁历史（用户看得见提示），
 *     估少了会在 provider 侧炸 400。所以「加长文本，估算不能变小」
 *  2. 截断只发生在**轮边界**：assistant 的回答不能被从中间砍掉
 *  3. 最后一条 user 消息**永远保留** —— 丢了它这次请求就没有输入了
 *  4. 检索片段至少保留第一条：全丢了模型只能凭印象瞎答，比多花点 token 糟糕得多
 */

function msg(role: string, chars: number): TokenCountableMessage {
  return { role, content: '问'.repeat(chars) };
}

describe('estimateTokens · 粗估', () => {
  it('空串是 0', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('纯中文按 1.5 token/字估', () => {
    // 100 字 × 1.5 = 150
    expect(estimateTokens('中'.repeat(100))).toBe(150);
  });

  it('纯英文按 4 字符 ≈ 1 token 估', () => {
    // 400 字符 ÷ 4 = 100
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });

  it('中英混合落在两者之间', () => {
    // 100 个中文字（150 token）+ 400 个英文字符（100 token）
    expect(estimateTokens(`${'中'.repeat(100)}${'a'.repeat(400)}`)).toBe(250);
  });

  it('单调性：文本变长，估算不能变小', () => {
    const base = '年假政策说明';
    let prev = 0;
    for (let i = 1; i <= 10; i += 1) {
      const n = estimateTokens(base.repeat(i));
      expect(n).toBeGreaterThanOrEqual(prev);
      prev = n;
    }
  });
});

describe('estimateMessagesTokens · 含每条消息的固定开销', () => {
  it('空数组是 0', () => {
    expect(estimateMessagesTokens([])).toBe(0);
  });

  it('每条消息都算上 MESSAGE_OVERHEAD_TOKENS', () => {
    const messages = [msg('user', 10), msg('assistant', 10)];
    const plain = estimateTokens('问'.repeat(10));
    expect(estimateMessagesTokens(messages)).toBe(
      (plain + MESSAGE_OVERHEAD_TOKENS) * 2,
    );
  });
});

describe('fitHistoryToBudget · 历史裁剪', () => {
  it('空历史原样返回', () => {
    expect(fitHistoryToBudget([], { maxTokens: 100, maxTurns: 10 })).toEqual({
      kept: [],
      droppedTurns: 0,
      estimatedTokens: 0,
      dropped: [],
    });
  });

  it('被丢掉的消息本身也交出来（摘要压缩要拿它去总结）', () => {
    const history: TokenCountableMessage[] = [];
    for (let i = 1; i <= 3; i += 1) {
      history.push({ role: 'user', content: `问题 ${i}`, ref: `u${i}` });
      history.push({ role: 'assistant', content: `回答 ${i}`, ref: `a${i}` });
    }
    const r = fitHistoryToBudget(history, { maxTokens: 100000, maxTurns: 1 });
    expect(r.droppedTurns).toBe(2);
    // 丢掉的是最老的两轮，顺序从旧到新
    expect(r.dropped.map((m) => m.ref)).toEqual(['u1', 'a1', 'u2', 'a2']);
    // kept + dropped = 全部，一条不漏（按时间从旧到新）
    expect([...r.dropped, ...r.kept].map((m) => m.ref)).toEqual(
      history.map((m) => m.ref),
    );
  });

  it('没丢东西时 dropped 是空数组', () => {
    const r = fitHistoryToBudget([msg('user', 10)], { maxTokens: 10000, maxTurns: 10 });
    expect(r.dropped).toEqual([]);
  });

  it('预算充足时全部保留，droppedTurns = 0', () => {
    const history = [msg('user', 10), msg('assistant', 20)];
    const r = fitHistoryToBudget(history, { maxTokens: 10000, maxTurns: 10 });
    expect(r.kept).toHaveLength(2);
    expect(r.droppedTurns).toBe(0);
  });

  it('只按轮数上限砍时，保留的一定是最新那几轮', () => {
    // 5 轮，每轮 user + assistant
    const history: TokenCountableMessage[] = [];
    for (let i = 0; i < 5; i += 1) {
      history.push(msg('user', 10));
      history.push(msg('assistant', 10));
    }
    const r = fitHistoryToBudget(history, { maxTokens: 100000, maxTurns: 2 });
    expect(r.kept).toHaveLength(4); // 2 轮 × (user + assistant)
    expect(r.droppedTurns).toBe(3);
    // 保留的应该从第 4 轮开始
    expect(r.kept[0]).toEqual(msg('user', 10));
    expect(r.kept).toEqual(history.slice(6));
  });

  it('超 token 预算时丢弃更早的轮次，保留最新的', () => {
    const history: TokenCountableMessage[] = [];
    for (let i = 0; i < 10; i += 1) {
      history.push(msg('user', 100));
      history.push(msg('assistant', 100));
    }
    // 每轮 ≈ 100×1.5×2 + 8 = 308 token；只给 1000 → 大约装得下 3 轮
    const r = fitHistoryToBudget(history, { maxTokens: 1000, maxTurns: 100 });
    expect(r.droppedTurns).toBeGreaterThan(0);
    expect(r.kept.length).toBeLessThan(history.length);
    // 最后一条一定在里面
    expect(r.kept[r.kept.length - 1]).toEqual(history[history.length - 1]);
  });

  it('最后一条 user 消息永远保留（哪怕它一个人就超预算）', () => {
    // 两轮：第一轮 user+assistant，第二轮只有 user（就是本轮）
    const history = [msg('user', 10), msg('assistant', 10), msg('user', 100000)];
    const r = fitHistoryToBudget(history, { maxTokens: 1, maxTurns: 10 });
    expect(r.kept).toHaveLength(1);
    expect(r.kept[0]).toEqual(msg('user', 100000));
    expect(r.droppedTurns).toBe(1);
  });

  it('不会从中间切断一轮（assistant 的回答总是完整保留）', () => {
    const history: TokenCountableMessage[] = [];
    for (let i = 0; i < 6; i += 1) {
      history.push(msg('user', 10));
      history.push(msg('assistant', 10));
    }
    const r = fitHistoryToBudget(history, { maxTokens: 400, maxTurns: 10 });
    // kept 必须是 [user, assistant] 成对出现
    expect(r.kept.length % 2).toBe(0);
    for (let i = 0; i < r.kept.length; i += 2) {
      expect(r.kept[i]?.role).toBe('user');
      expect(r.kept[i + 1]?.role).toBe('assistant');
    }
  });

  it('maxTurns = 0 不崩，且仍然保留最后一轮', () => {
    const history = [msg('user', 10), msg('assistant', 10), msg('user', 10)];
    const r = fitHistoryToBudget(history, { maxTokens: 10000, maxTurns: 0 });
    expect(r.kept.length).toBeGreaterThan(0);
    expect(r.kept[r.kept.length - 1]).toEqual(msg('user', 10));
  });

  it('异常数据（没有 user 消息）原样返回', () => {
    const history = [msg('assistant', 10), msg('assistant', 20)];
    const r = fitHistoryToBudget(history, { maxTokens: 1, maxTurns: 10 });
    expect(r.kept).toHaveLength(2);
    expect(r.droppedTurns).toBe(0);
  });
});

describe('fitHitsToBudget · 检索片段裁剪', () => {
  const hit = (chars: number) => ({ text: '片'.repeat(chars) });

  it('空数组返回空', () => {
    expect(fitHitsToBudget([], 100)).toEqual([]);
  });

  it('预算充足时全部保留', () => {
    const hits = [hit(10), hit(10), hit(10)];
    expect(fitHitsToBudget(hits, 10000)).toHaveLength(3);
  });

  it('装不下时从尾部开始丢，保留的是最高分的', () => {
    // 每条 100 字 ≈ 150 token，给 400 → 装得下 2 条
    const hits = [hit(100), hit(100), hit(100)];
    const kept = fitHitsToBudget(hits, 400);
    expect(kept).toHaveLength(2);
    expect(kept[0]).toBe(hits[0]);
    expect(kept[1]).toBe(hits[1]);
  });

  it('哪怕只剩第一条超预算，也要留下第一条', () => {
    const hits = [hit(1000), hit(10)];
    const kept = fitHitsToBudget(hits, 1);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toBe(hits[0]);
  });
});