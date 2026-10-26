import { describe, it, expect } from 'vitest';
import {
  cosineSimilarity,
  compareMemoryPriority,
  normalizeVector,
  rankByRelevance,
  readStoredEmbedding,
  serializeEmbedding,
} from '../../src/services/memory-relevance';
import type { UserMemory } from '../../src/models';

/**
 * 记忆的向量召回 —— B4 的「记忆检索」那一项
 * （docs/07-c-模块-rag记忆状态协议.md 模块 10 · docs/12-b-需求-ai对话能力.md §B4）
 *
 * 这些都是**纯函数**（不碰网络也不碰数据库），所以可以随便喂奇怪输入。
 */

/** 造一条假的记忆行 */
const row = (
  id: string,
  content: string,
  over: Partial<UserMemory> = {},
): UserMemory =>
  ({
    id,
    tenant_id: 't1',
    user_id: 'u1',
    category: 'fact',
    content,
    source: 'auto',
    confidence: 0.8,
    status: 'active',
    hit_count: 0,
    last_hit_at: null,
    source_session_id: null,
    source_message_id: null,
    embedding: null,
    embedding_model: null,
    created_at: new Date(0),
    updated_at: new Date(0),
    ...over,
  }) as UserMemory;

describe('normalizeVector · 归一化', () => {
  it('长度变成 1', () => {
    const v = normalizeVector([3, 4]);
    expect(v[0]).toBeCloseTo(0.6, 6);
    expect(v[1]).toBeCloseTo(0.8, 6);
  });

  it('零向量原样返回（不炸）', () => {
    expect(normalizeVector([0, 0])).toEqual([0, 0]);
  });
});

describe('cosineSimilarity · 余弦相似度', () => {
  it('同一个向量 = 1', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
  });

  it('正交的 = 0', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });

  it('方向相反 = -1', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 6);
  });

  it('长度不一样 → 0（不能拿两套维度的向量算）', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it('空向量 → 0', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe('serializeEmbedding · 存库前', () => {
  it('归一化 + 记下模型名', () => {
    const stored = serializeEmbedding([3, 4], 'test-embed');
    expect(stored.embedding_model).toBe('test-embed');
    expect(stored.embedding[0]).toBeCloseTo(0.6, 6);
  });

  it('保留 6 位小数（JSON 体积砍一半，精度还是 float32 级别）', () => {
    const stored = serializeEmbedding([1 / 3, 1], 'm');
    // 先归一化：(1/3) / sqrt(1/9 + 1) = 0.316228…
    expect(String(stored.embedding[0])).toBe('0.316228');
  });
});

describe('readStoredEmbedding · 读库', () => {
  it('模型名对得上才读得到', () => {
    const r = row('m1', 'x', { embedding: [1, 0], embedding_model: 'test-embed' });
    expect(readStoredEmbedding(r, 'test-embed')).toEqual([1, 0]);
  });

  it('⚠️ 换了 embedding 模型 → 旧向量作废（读成没有）', () => {
    const r = row('m1', 'x', { embedding: [1,  0], embedding_model: 'old-embed' });
    expect(readStoredEmbedding(r, 'new-embed')).toBeNull();
  });

  it('没存向量 → null', () => {
    expect(readStoredEmbedding(row('m1', 'x'), 'test-embed')).toBeNull();
  });

  it('存的不是合法向量 → null（不拿脏数据去算）', () => {
    const bad = row('m1', 'x', { embedding: ['a', 'b'] as never, embedding_model: 'm' });
    expect(readStoredEmbedding(bad, 'm')).toBeNull();
  });

  it('驱动没解析 JSON 时给的是字符串，也能读出来', () => {
    const asString = row('m1', 'x', {
      embedding: '[1,0]' as never,
      embedding_model: 'm',
    });
    expect(readStoredEmbedding(asString, 'm')).toEqual([1, 0]);
  });
});

describe('compareMemoryPriority · 优先级兜底', () => {
  it('用户写的 > 管理员写的 > 自动抽的', () => {
    const user = row('u', 'x', { source: 'user', confidence: 0.1 });
    const admin = row('a', 'x', { source: 'admin', confidence: 1 });
    const auto = row('b', 'x', { source: 'auto', confidence: 1 });
    expect(compareMemoryPriority(user, admin)).toBeLessThan(0);
    expect(compareMemoryPriority(admin, auto)).toBeLessThan(0);
  });

  it('同来源按置信度降序', () => {
    const high = row('a', 'x', { source: 'auto', confidence: 0.9 });
    const low = row('b', 'x', { source: 'auto', confidence: 0.2 });
    expect(compareMemoryPriority(high, low)).toBeLessThan(0);
  });
});

describe('rankByRelevance · 按相关性排', () => {
  it('相关的排前面 —— 这正是本特性要解决的事', () => {
    const rows = [
      row('m1', '我喜欢简洁的回答', { embedding: [1, 0], embedding_model: 'm' }),
      row('m2', '发票抬头是 XX 公司', { embedding: [0, 1], embedding_model: 'm' }),
    ];
    // 问题跟「发票」同向
    const { rows: ranked } = rankByRelevance(rows, [0, 1], 'm');
    expect(ranked[0]?.id).toBe('m2');
  });

  it('相关性相同时按优先级兜底（用户写的在前）', () => {
    const rows = [
      row('auto-1', 'x', { embedding: [1, 0], embedding_model: 'm', source: 'auto' }),
      row('user-1', 'y', { embedding: [1, 0], embedding_model: 'm', source: 'user' }),
    ];
    const { rows: ranked } = rankByRelevance(rows, [1, 0], 'm');
    expect(ranked[0]?.id).toBe('user-1');
  });

  it('⚠️ 没有向量的记忆按 0 分算，不会被饿死（仍按优先级排在同档）', () => {
    const rows = [
      row('auto-1', 'x', { embedding: [1, 0], embedding_model: 'm', source: 'auto' }),
      row('user-1', 'y', { source: 'user' }), // 没向量
    ];
    // 问题跟 auto-1 正交（相似度 0）→ 两条同档 → 优先级决定
    const { rows: ranked, scores } = rankByRelevance(rows, [0, 1], 'm');
    expect(scores.get('user-1')).toBe(0);
    expect(ranked[0]?.id).toBe('user-1');
  });

  it('向量过期（换过 embedding 模型）的按 0 分算', () => {
    const stale = row('m1', 'x', { embedding: [1, 0], embedding_model: 'old-model' });
    const { scores } = rankByRelevance([stale], [1, 0], 'new-model');
    expect(scores.get('m1')).toBe(0);
  });

  it('得分能对上余弦相似度', () => {
    const rows = [row('m1', 'x', { embedding: [1, 0], embedding_model: 'm' })];
    const { scores } = rankByRelevance(rows, [1, 0], 'm');
    expect(scores.get('m1')).toBeCloseTo(1, 6);
  });
});
