import { describe, it, expect } from 'vitest';
import { fuse } from '../../src/rag/hybrid-search';
import type { Bm25Hit } from '../../src/rag/bm25';
import type { VectorHit } from '../../src/rag/qdrant';

/**
 * RRF 融合（src/rag/hybrid-search.ts 的 fuse）—— 纯函数，不碰网络
 *
 * 这里锁住三条最容易在重构时悄悄坏掉的语义：
 *  1. 两路都命中的块一定排在单路命中的前面
 *  2. score 是绝对归一化（双路第一 = 1.0，单路第一 = 0.5），不是「相对本次最高分」
 *  3. 同一块在两路的结果里被合并成一条，不是出现两次
 */

function vec(over: Partial<VectorHit> & { doc_id: string; chunk_index: number }): VectorHit {
  return {
    source: `${over.doc_id}.md`,
    text: `文本 ${over.doc_id}#${over.chunk_index}`,
    score: 0.9,
    ...over,
  };
}

function bm(over: Partial<Bm25Hit> & { doc_id: string; chunk_index: number }): Bm25Hit {
  return {
    source: `${over.doc_id}.md`,
    text: `文本 ${over.doc_id}#${over.chunk_index}`,
    score: 12,
    ...over,
  };
}

describe('fuse · RRF 融合', () => {
  it('两路都召回的块排在前面', () => {
    const hits = fuse(
      [vec({ doc_id: 'a', chunk_index: 0 }), vec({ doc_id: 'b', chunk_index: 0 })],
      [bm({ doc_id: 'b', chunk_index: 0 }), bm({ doc_id: 'c', chunk_index: 0 })],
      5,
    );
    expect(hits[0]?.doc_id).toBe('b');
    expect(hits[0]?.sources).toEqual(['vector', 'bm25']);
  });

  it('同一个块被合并成一条，不重复出现', () => {
    const hits = fuse(
      [vec({ doc_id: 'a', chunk_index: 0 })],
      [bm({ doc_id: 'a', chunk_index: 0 })],
      5,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.vector_rank).toBe(1);
    expect(hits[0]?.bm25_rank).toBe(1);
  });

  it('doc_id 相同但 chunk_index 不同的块是两回事', () => {
    const hits = fuse(
      [vec({ doc_id: 'a', chunk_index: 0 }), vec({ doc_id: 'a', chunk_index: 1 })],
      [bm({ doc_id: 'a', chunk_index: 1 })],
      5,
    );
    expect(hits).toHaveLength(2);
    expect(hits[0]?.chunk_index).toBe(1);
  });

  it('score 是绝对归一化：双路第一 = 1.0，单路命中拿不到 0.5 以上', () => {
    const hits = fuse(
      [vec({ doc_id: 'a', chunk_index: 0 }), vec({ doc_id: 'b', chunk_index: 0 })],
      [bm({ doc_id: 'a', chunk_index: 0 })],
      5,
    );
    // a 两路都第一 = 1/(60+1) + 1/(60+1) = 2/61，正好是理论满分
    expect(hits[0]?.score).toBeCloseTo(1.0, 5);
    // b 只有向量一路，且是第 2 名：(1/62) / (2/61) ≈ 0.4919
    expect(hits[1]?.score).toBeCloseTo(0.4919, 3);
    expect(hits[1]?.score).toBeLessThan(0.5);
  });

  it('单路召回的块最高只能拿 0.5（denominator 是双路满分）', () => {
    const hits = fuse([vec({ doc_id: 'a', chunk_index: 0 })], [], 5);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.score).toBeCloseTo(0.5, 5);
    expect(hits[0]?.sources).toEqual(['vector']);
  });

  it('两路都空时返回空数组', () => {
    expect(fuse([], [], 5)).toEqual([]);
  });

  it('RRF 分数随排名递减（k=60 压得很平，单路名次差一位只差一点点）', () => {
    const hits = fuse(
      [
        vec({ doc_id: 'a', chunk_index: 0 }),
        vec({ doc_id: 'b', chunk_index: 0 }),
        vec({ doc_id: 'c', chunk_index: 0 }),
      ],
      [],
      5,
    );
    expect(hits[0]?.rrf_score).toBeGreaterThan(hits[1]?.rrf_score ?? 0);
    expect(hits[1]?.rrf_score).toBeGreaterThan(hits[2]?.rrf_score ?? 0);
    // 1/61 与 1/62 差约 1.6%，说明 k=60 确实压得很平
    expect((hits[0]?.rrf_score ?? 0) / (hits[1]?.rrf_score ?? 1)).toBeLessThan(1.05);
  });

  it('topK 截断在融合之后', () => {
    const hits = fuse(
      Array.from({ length: 10 }, (_, i) => vec({ doc_id: `d${i}`, chunk_index: 0 })),
      [],
      3,
    );
    expect(hits).toHaveLength(3);
  });

  it('只出现在 BM25 一路的块，vector_rank 为 null', () => {
    const hits = fuse(
      [vec({ doc_id: 'a', chunk_index: 0 })],
      [bm({ doc_id: 'z', chunk_index: 0 })],
      5,
    );
    const z = hits.find((h) => h.doc_id === 'z');
    expect(z?.vector_rank).toBeNull();
    expect(z?.bm25_rank).toBe(1);
    expect(z?.sources).toEqual(['bm25']);
  });

  it('同分时按 doc_id 排序，结果稳定可复现', () => {
    const input = [
      vec({ doc_id: 'zzz', chunk_index: 0 }),
      vec({ doc_id: 'aaa', chunk_index: 0 }),
    ];
    expect(fuse(input, [], 5).map((h) => h.doc_id)).toEqual(
      fuse(input, [], 5).map((h) => h.doc_id),
    );
  });
});