import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// ⚠️ mock 必须打在**被测模块的导入之前**（vitest 会把 vi.mock 提到文件顶部）。
vi.mock('../../src/rag/hybrid-search', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/rag/hybrid-search')>();
  return { ...actual, hybridSearch: vi.fn(async () => []) };
});

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: vi.fn(async () => ({ text: '年假 天数 入职时长' })) };
});

import { generateText } from 'ai';
import { hybridSearch } from '../../src/rag/hybrid-search';
import { retrieveForEvaluation } from '../../src/services/evaluation';
import type { ResolvedLlmSettings } from '../../src/services/llm-settings';

/**
 * 评测的检索 —— **跟线上对话同一套口径**（docs/12-d §D1）
 *
 * ## 这条测试在防什么
 *
 * D1 的验收原文：
 * > 「评测跑的是真实对话链路：同一套系统提示词 + **同一套检索** + 同一套模型」
 *
 * ⚠️ 2026-10-26 之前评测只调 `hybridSearch({query, tenantId, topK})`：
 *  - **不传 `rerankEnabled`** → 走平台总开关，租户关掉自己的重排时评测还在重排
 *  - **没有查询改写** → 租户开了 `query_rewrite_enabled` 时线上改了查询、评测没改
 *
 * 两条租户级开关任一被改，评测分数就不能代表线上表现了。
 * 下面锁住「两个开关都传下去了」。
 */
describe('评测检索 · 与线上口径一致', () => {
  beforeEach(() => {
    vi.mocked(generateText).mockReset();
    vi.mocked(generateText).mockResolvedValue({ text: '年假 天数 入职时长' } as never);
    vi.mocked(hybridSearch).mockReset();
    vi.mocked(hybridSearch).mockResolvedValue([]);
  });

  const llm = (over: Partial<ResolvedLlmSettings> = {}): ResolvedLlmSettings =>
    ({
      apiKey: 'sk-test',
      baseUrl: 'http://127.0.0.1:9/v1',
      model: 'test-model',
      retrievalTopK: 5,
      queryRewriteEnabled: false,
      rerankEnabled: true,
      ...over,
    }) as unknown as ResolvedLlmSettings;

  it('租户关掉重排 → 检索调用里 rerankEnabled 必须是 false（不是 undefined）', async () => {
    await retrieveForEvaluation({
      tenantId: 'tenant-a',
      question: '年假几天',
      llm: llm({ rerankEnabled: false }),
    });
    expect(hybridSearch).toHaveBeenCalledTimes(1);
    const args = vi.mocked(hybridSearch).mock.calls[0]?.[0];
    expect(args?.rerankEnabled).toBe(false);
  });

  it('租户开着重排 → rerankEnabled 透传为 true', async () => {
    await retrieveForEvaluation({
      tenantId: 'tenant-a',
      question: '年假几天',
      llm: llm({ rerankEnabled: true }),
    });
    const args = vi.mocked(hybridSearch).mock.calls[0]?.[0];
    expect(args?.rerankEnabled).toBe(true);
  });

  it('租户开着查询改写 → 检索用的是改写后的查询（跟线上一样）', async () => {
    const r = await retrieveForEvaluation({
      tenantId: 'tenant-a',
      question: '我入职三个月能休几天年假',
      llm: llm({ queryRewriteEnabled: true }),
    });
    const args = vi.mocked(hybridSearch).mock.calls[0]?.[0];
    expect(args?.query).toBe('年假 天数 入职时长');
    expect(r.effectiveQuery).toBe('年假 天数 入职时长');
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it('租户没开查询改写 → 不发那次模型调用，原问题直接检索', async () => {
    const r = await retrieveForEvaluation({
      tenantId: 'tenant-a',
      question: '我入职三个月能休几天年假',
      llm: llm({ queryRewriteEnabled: false }),
    });
    const args = vi.mocked(hybridSearch).mock.calls[0]?.[0];
    expect(args?.query).toBe('我入职三个月能休几天年假');
    expect(r.effectiveQuery).toBe('我入职三个月能休几天年假');
    expect(generateText).not.toHaveBeenCalled();
  });

  it('topK 用租户配的检索条数', async () => {
    await retrieveForEvaluation({
      tenantId: 'tenant-a',
      question: '年假几天',
      llm: llm({ retrievalTopK: 7 }),
    });
    const args = vi.mocked(hybridSearch).mock.calls[0]?.[0];
    expect(args?.topK).toBe(7);
  });

  it('检索整体挂掉 → 降级成「无资料回答」，不抛错', async () => {
    vi.mocked(hybridSearch).mockRejectedValue(new Error('qdrant 挂了'));
    const r = await retrieveForEvaluation({
      tenantId: 'tenant-a',
      question: '年假几天',
      llm: llm(),
    });
    expect(r.hits).toEqual([]);
    expect(r.retrievalError).toBe('知识库检索暂时不可用，本次回答没有使用参考资料。');
  });
});

/**
 * **防口径漂移的结构性守卫**
 *
 * 上面几条测的是「评测这条链路对不对」；
 * 这一条测的是「**线上和评测是不是真的走同一个入口**」——
 * 哪天有人为了图省事，在某一侧又内联了一份 `rewriteQuery`，
 * 两边就又漂回去了，而且从单测里看不出来。
 */
describe('检索口径 · 线上与评测必须走同一个入口', () => {
  const SRC = path.resolve(__dirname, '../../src');

  /**
   * 扫源码前先剥掉注释 ——
   * 文档里引用一句 `hybridSearch({query, tenantId, topK})` 不算违规
   * （跟 tenant-isolation-guard.test.ts 的做法一致）。
   */
  function codeOf(file: string): string {
    const raw = readFileSync(path.join(SRC, file), 'utf8');
    return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  }

  it('chat.ts 和 evaluation.ts 都调 planRetrieval（而不是各写一份改写）', () => {
    for (const file of ['services/chat.ts', 'services/evaluation.ts']) {
      const code = codeOf(file);
      expect(code, `${file} 应该调 planRetrieval`).toContain('planRetrieval(');
      expect(code, `${file} 不该直接调 rewriteQuery`).not.toContain('rewriteQuery(');
    }
  });

  it('两侧的 hybridSearch 调用都传了 rerankEnabled', () => {
    for (const file of ['services/chat.ts', 'services/evaluation.ts']) {
      const code = codeOf(file);
      const calls = code.split('hybridSearch(').slice(1);
      expect(calls.length, `${file} 应该有 hybridSearch 调用`).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.slice(0, 400), `${file} 的 hybridSearch 调用要传 rerankEnabled`).toContain(
          'rerankEnabled:',
        );
      }
    }
  });
});
