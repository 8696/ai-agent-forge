import { describe, it, expect, vi, beforeEach } from 'vitest';

// ⚠️ mock 必须打在**被测模块的导入之前**（vitest 会把 vi.mock 提到文件顶部）。
vi.mock('ai', () => ({
  generateText: vi.fn(async () => ({ text: '年假 天数 入职时长 满1年不满10年' })),
}));

import { generateText } from 'ai';
import { rewriteQuery } from '../../src/rag/query-rewrite';
import { SETTINGS_REGISTRY } from '../../src/services/tenant-settings';

/**
 * 查询改写 —— docs/12-b §B2
 *
 * 关键语义：**改写是锦上添花，挂了不能影响检索**。
 * 所以失败路径（报错 / 超时 / 空输出 / 改出来跟原话一样）全都回落原查询。
 */
describe('查询改写 · B2', () => {
  beforeEach(() => {
    vi.mocked(generateText).mockReset();
    vi.mocked(generateText).mockResolvedValue({
      text: '年假 天数 入职时长 满1年不满10年',
    } as never);
  });

  const base = {
    query: '我入职三个月能休几天年假',
    apiKey: 'sk-test',
    baseUrl: 'http://127.0.0.1:9/v1',
    model: 'test-model',
    timeoutMs: 1000,
  };

  it('改写成功 → effectiveQuery 是改写后的文本', async () => {
    const r = await rewriteQuery(base);
    expect(r.rewritten).toBe('年假 天数 入职时长 满1年不满10年');
    expect(r.effectiveQuery).toBe('年假 天数 入职时长 满1年不满10年');
  });

  it('模型报错 → 回落原查询，不抛错', async () => {
    vi.mocked(generateText).mockRejectedValue(new Error('模型挂了'));
    const r = await rewriteQuery(base);
    expect(r.rewritten).toBeNull();
    expect(r.effectiveQuery).toBe(base.query);
  });

  it('模型返回空 → 回落原查询', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: '   ' } as never);
    const r = await rewriteQuery(base);
    expect(r.rewritten).toBeNull();
    expect(r.effectiveQuery).toBe(base.query);
  });

  it('改出来跟原话一样 → 视为没改写（不白花一次调用）', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: base.query } as never);
    const r = await rewriteQuery(base);
    expect(r.rewritten).toBeNull();
    expect(r.effectiveQuery).toBe(base.query);
  });

  it('改写结果过长 → 回落原查询', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: 'x'.repeat(600) } as never);
    const r = await rewriteQuery(base);
    expect(r.rewritten).toBeNull();
    expect(r.effectiveQuery).toBe(base.query);
  });

  it('改写结果里的换行会被压成空格（检索词不能带换行）', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: '年假\n天数   入职时长' } as never);
    const r = await rewriteQuery(base);
    expect(r.rewritten).toBe('年假 天数 入职时长');
  });

  it('超时 → 回落原查询', async () => {
    // 永不 resolve 的 promise —— withTimeout 应该兜住
    vi.mocked(generateText).mockImplementation(() => new Promise(() => {}));
    const r = await rewriteQuery({ ...base, timeoutMs: 50 });
    expect(r.rewritten).toBeNull();
    expect(r.effectiveQuery).toBe(base.query);
  });
});

describe('查询改写 · 租户开关', () => {
  it('在 registry 里，默认关闭（每轮多一次模型调用，不能默认开）', () => {
    const spec = SETTINGS_REGISTRY.find((s) => s.key === 'query_rewrite_enabled');
    expect(spec).toBeDefined();
    expect(spec?.type).toBe('boolean');
    expect(spec?.fallback).toBe(false);
  });
});
