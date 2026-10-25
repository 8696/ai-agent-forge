import { describe, it, expect, vi, afterEach } from 'vitest';
import { fuse, rerankAndTrim } from '../../src/rag/hybrid-search';
import { normalizeRerankScores, type RerankConfig } from '../../src/rag/rerank';
import type { VectorHit } from '../../src/rag/qdrant';

/**
 * 重排序（src/rag/rerank.ts + hybrid-search.ts 的 rerankAndTrim）—— 不碰真实服务
 *
 * 这里锁住四条最容易在重构时悄悄坏掉的语义：
 *  1. 重排真的会改顺序（RRF 排第一的不一定还是第一）
 *  2. 重排不可用时**降级**回纯 RRF 顺序，不能抛错把检索带崩
 *  3. 截断 topK 发生在**重排之后**（重排把第 3 名提上来，topK=1 时就该是它）
 *  4. 开关关掉时**一次请求都不该发**
 */

const CFG: RerankConfig = {
  enabled: true,
  apiUrl: 'http://rerank.test/v1/rerank',
  apiKey: 'test-key',
  model: 'bge-reranker-v2-m3',
  timeoutMs: 1000,
  candidates: 20,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function vec(docId: string, chunkIndex = 0): VectorHit {
  return {
    doc_id: docId,
    chunk_index: chunkIndex,
    source: `${docId}.md`,
    text: `文本 ${docId}#${chunkIndex}`,
    score: 0.9,
  };
}

/** 造一批只走向量一路的候选（RRF 顺序 = 输入顺序） */
function candidates(...ids: string[]): ReturnType<typeof fuse> {
  return fuse(ids.map((id) => vec(id)), [], ids.length);
}

function mockRerankOk(results: Array<{ index: number; relevance_score: number }>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ results }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('rerankAndTrim · 重排序', () => {
  it('重排后顺序与纯 RRF 不同：模型把第 5 名提到了第一', async () => {
    const cands = candidates('a', 'b', 'c', 'd', 'e');
    expect(cands.map((h) => h.doc_id)).toEqual(['a', 'b', 'c', 'd', 'e']);

    const fetchMock = mockRerankOk([
      { index: 4, relevance_score: 0.98 },
      { index: 3, relevance_score: 0.9 },
      { index: 0, relevance_score: 0.5 },
      { index: 1, relevance_score: 0.4 },
      { index: 2, relevance_score: 0.3 },
    ]);

    const out = await rerankAndTrim('问题', cands, 3, { config: CFG });

    expect(out.map((h) => h.doc_id)).toEqual(['e', 'd', 'a']);
    expect(out[0]?.rerank_score).toBeCloseTo(0.98, 5);
    // 重排分本身就是展示用的相关度（在 [0,1] 内时原样用）
    expect(out[0]?.score).toBeCloseTo(0.98, 5);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('请求体是 Cohere 兼容格式，候选文本原样送过去', async () => {
    const fetchMock = mockRerankOk([{ index: 0, relevance_score: 0.5 }]);
    await rerankAndTrim('年假几天', candidates('a', 'b'), 2, { config: CFG });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      model: string;
      query: string;
      documents: string[];
      top_n: number;
    };
    expect(body.model).toBe('bge-reranker-v2-m3');
    expect(body.query).toBe('年假几天');
    expect(body.documents).toEqual(['文本 a#0', '文本 b#0']);
    expect(body.top_n).toBe(2);
  });

  it('重排不可用（网络错误）时降级：顺序回到纯 RRF，且不抛错', async () => {
    const cands = candidates('a', 'b', 'c', 'd', 'e');
    const fetchMock = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    vi.stubGlobal('fetch', fetchMock);

    const out = await rerankAndTrim('问题', cands, 3, { config: CFG });

    expect(out.map((h) => h.doc_id)).toEqual(['a', 'b', 'c']);
    expect(out.every((h) => h.rerank_score === null)).toBe(true);
    // 降级后 score 仍然是归一化 RRF 分（a 只有向量一路 → 0.5）
    expect(out[0]?.score).toBeCloseTo(0.5, 5);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('重排服务返回 5xx 时同样降级', async () => {
    const fetchMock = vi.fn(async () => new Response('boom', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    const out = await rerankAndTrim('问题', candidates('a', 'b'), 2, { config: CFG });

    expect(out.map((h) => h.doc_id)).toEqual(['a', 'b']);
    expect(out[0]?.rerank_score).toBeNull();
  });

  it('响应格式不对时降级（不猜下标 —— 猜错会把不相干的块排到前面）', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ results: [{ index: 99, relevance_score: 0.9 }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const out = await rerankAndTrim('问题', candidates('a', 'b'), 2, { config: CFG });

    expect(out.map((h) => h.doc_id)).toEqual(['a', 'b']);
    expect(out[0]?.rerank_score).toBeNull();
  });

  it('响应里没有 results 数组时降级', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const out = await rerankAndTrim('问题', candidates('a', 'b'), 2, { config: CFG });

    expect(out.map((h) => h.doc_id)).toEqual(['a', 'b']);
  });

  it('topK 截断发生在重排之后：重排提上来的第 3 名在 topK=1 时就是唯一结果', async () => {
    mockRerankOk([
      { index: 2, relevance_score: 0.95 },
      { index: 0, relevance_score: 0.5 },
      { index: 1, relevance_score: 0.4 },
    ]);

    const out = await rerankAndTrim('问题', candidates('a', 'b', 'c'), 1, { config: CFG });

    expect(out).toHaveLength(1);
    expect(out[0]?.doc_id).toBe('c');
  });

  it('平台总开关关掉时一次请求都不发', async () => {
    const fetchMock = mockRerankOk([{ index: 0, relevance_score: 0.5 }]);

    const out = await rerankAndTrim('问题', candidates('a', 'b'), 2, {
      config: { ...CFG, enabled: false },
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.map((h) => h.doc_id)).toEqual(['a', 'b']);
  });

  it('租户开关关掉时一次请求都不发（平台开着也不行）', async () => {
    const fetchMock = mockRerankOk([{ index: 0, relevance_score: 0.5 }]);

    const out = await rerankAndTrim('问题', candidates('a', 'b'), 2, {
      config: CFG,
      tenantEnabled: false,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.map((h) => h.doc_id)).toEqual(['a', 'b']);
  });

  it('没配重排地址时直接走纯 RRF（配好地址即生效，不用再翻开关）', async () => {
    const fetchMock = mockRerankOk([{ index: 0, relevance_score: 0.5 }]);

    const out = await rerankAndTrim('问题', candidates('a', 'b'), 2, {
      config: { ...CFG, apiUrl: '' },
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.map((h) => h.doc_id)).toEqual(['a', 'b']);
  });

  it('超长的候选文本截断后再送（防请求体被撑大）', async () => {
    const fetchMock = mockRerankOk([{ index: 0, relevance_score: 0.5 }]);
    const long = 'x'.repeat(5000);
    const cands = candidates('a');
    const hit = cands[0];
    if (hit === undefined) throw new Error('测试数据缺失');
    hit.text = long;

    await rerankAndTrim('问题', [hit], 1, { config: CFG });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { documents: string[] };
    expect(body.documents[0]?.length).toBe(2000);
  });

  it('没有候选时不发请求', async () => {
    const fetchMock = mockRerankOk([{ index: 0, relevance_score: 0.5 }]);

    const out = await rerankAndTrim('问题', [], 5, { config: CFG });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(out).toEqual([]);
  });

  it('服务没返回的候选排在最后（宁可保守也不把没评过分的排前面）', async () => {
    mockRerankOk([{ index: 1, relevance_score: 0.9 }]);

    const out = await rerankAndTrim('问题', candidates('a', 'b', 'c'), 3, { config: CFG });

    expect(out[0]?.doc_id).toBe('b');
    expect(out[0]?.rerank_score).toBeCloseTo(0.9, 5);
    expect(out.slice(1).map((h) => h.doc_id)).toEqual(['a', 'c']);
    expect(out.slice(1).every((h) => h.rerank_score === null)).toBe(true);
  });
});

describe('normalizeRerankScores · 展示用相关度', () => {
  it('分数本来就在 [0,1] 时原样用（不同检索之间可比）', () => {
    expect(normalizeRerankScores([0.2, 0.8, 0.5])).toEqual([0.2, 0.8, 0.5]);
  });

  it('分数超出 [0,1]（logits）时按批次 min-max 归一化', () => {
    expect(normalizeRerankScores([-2, 0, 2])).toEqual([0, 0.5, 1]);
  });

  it('全一样时没有区分度，全给 0（别假装有）', () => {
    expect(normalizeRerankScores([3, 3, 3])).toEqual([0, 0, 0]);
  });

  it('只有一条时它是唯一候选也就是第一名，给 1（不是 0）', () => {
    expect(normalizeRerankScores([3])).toEqual([1]);
  });

  it('空数组原样返回', () => {
    expect(normalizeRerankScores([])).toEqual([]);
  });
});
