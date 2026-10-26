import { describe, it, expect, vi, beforeEach } from 'vitest';

// ⚠️ mock 必须打在**被测模块的导入之前**（vitest 会把 vi.mock 提到文件顶部）。
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: vi.fn(async () => ({ text: '年假 天数 入职时长' })) };
});

import { generateText } from 'ai';
import { planRetrieval } from '../../src/rag/retrieval-plan';

/**
 * 检索计划 —— **线上对话与评测共用的同一份口径**
 *
 * ## 锁住什么
 *
 * D1 的验收原文（docs/12-d §D1）：
 * > 「评测跑的是真实对话链路：同一套系统提示词 + **同一套检索** + 同一套模型」
 *
 * 「同一套检索」包含两件各自实现最容易漏的事：
 *  1. **查询改写** —— 租户开了 `query_rewrite_enabled`，线上会先改写再检索
 *  2. **重排** —— 租户关了 `rerank_enabled`，线上走纯 RRF 排序
 *
 * ⚠️ 2026-10-26 之前评测这两样都没跟（只调 `hybridSearch({query, tenantId, topK})`），
 * 租户一改开关，评测分数就不能代表线上表现了。
 * 现在两边都经 `planRetrieval()` —— 这个测试锁住「开关关时不发那次多余的模型调用」。
 */
describe('检索计划 · 线上与评测共用', () => {
  beforeEach(() => {
    vi.mocked(generateText).mockReset();
    vi.mocked(generateText).mockResolvedValue({ text: '年假 天数 入职时长' } as never);
  });

  const base = {
    query: '我入职三个月能休几天年假',
    queryRewriteEnabled: true,
    rerankEnabled: true,
    apiKey: 'sk-test',
    baseUrl: 'http://127.0.0.1:9/v1',
    model: 'test-model',
  };

  it('开关关着 → 不发那次模型调用，原查询直接拿去检索', async () => {
    const plan = await planRetrieval({ ...base, queryRewriteEnabled: false });
    expect(plan.query).toBe(base.query);
    expect(plan.rewritten).toBeNull();
    expect(generateText).not.toHaveBeenCalled();
  });

  it('开关开着 → 检索用的是改写后的查询', async () => {
    const plan = await planRetrieval(base);
    expect(plan.query).toBe('年假 天数 入职时长');
    expect(plan.rewritten).toBe('年假 天数 入职时长');
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it('改写失败 → 回落原查询，不抛错（改写挂了不能影响检索）', async () => {
    vi.mocked(generateText).mockRejectedValue(new Error('模型挂了'));
    const plan = await planRetrieval(base);
    expect(plan.query).toBe(base.query);
    expect(plan.rewritten).toBeNull();
  });

  it('重排开关原样透传（false 也不能被当成 undefined）', async () => {
    const off = await planRetrieval({ ...base, queryRewriteEnabled: false, rerankEnabled: false });
    expect(off.rerankEnabled).toBe(false);
    const on = await planRetrieval({ ...base, queryRewriteEnabled: false, rerankEnabled: true });
    expect(on.rerankEnabled).toBe(true);
  });
});
