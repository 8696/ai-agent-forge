import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { allHttpFromTokensFile, adminHttp, readTokensFile, type AllHttp } from '../helpers';
import { getSequelize } from '../../src/db';
import {
  EvaluationDataset,
  EvaluationItem,
  EvaluationResult,
  EvaluationRun,
  PromptVersion,
  Tenant,
} from '../../src/models';

/**
 * A/B 对比（docs/12-e 裁定表 表 4）—— 端到端验证
 *
 * 覆盖三块：
 *   1. **跑批能指定提示词版本**（服务层，mock 掉 LLM → 零成本）
 *   2. **指定不存在的版本 → 400**（HTTP 层，同步拒绝，不留半成品 run）
 *   3. **两个 run 的对比接口**（HTTP 层，DB 里直接造数据 → 零成本）
 *
 * ⚠️ **不打真 LLM**：第 1 组用 vi.mock 把 `ai` 换成假的，
 *    第 3 组直接往库里塞打分明细 —— 全程不产生一分钱费用。
 */

/**
 * ⚠️ mock 必须打在**被测模块的导入之前**（vitest 会把 vi.mock 提到文件顶部）。
 *
 * `vi.hoisted` 里的变量在导入之前就建好了 —— 否则 mock 工厂里引用它会撞 TDZ。
 */
const state = vi.hoisted(() => ({
  /** 每次 generateText 收到的 system 提示词 —— 用来验证「跑的到底是哪一版」 */
  captured: [] as Array<{ system: string }>,
  /** 假装租户「当前生效」的提示词版本 */
  activePromptVersion: null as string | null,
}));

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    generateText: vi.fn(async (opts: { system?: string }) => {
      const system = String(opts.system ?? '');
      state.captured.push({ system });
      // 裁判那一路的 system 提示词里有「评测裁判」四个字 —— 据此区分两次调用
      if (system.includes('评测裁判')) {
        return {
          text: JSON.stringify({
            accuracy: 4,
            completeness: 4,
            style: 5,
            safety: 5,
            reason: '测试打分',
          }),
          usage: { inputTokens: 100, outputTokens: 20 },
        };
      }
      return { text: '这是测试回答', usage: { inputTokens: 100, outputTokens: 20 } };
    }),
  };
});

// 检索不碰 Qdrant —— 本测试只关心「用的哪一版提示词」
vi.mock('../../src/rag/hybrid-search', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/rag/hybrid-search')>();
  return { ...actual, hybridSearch: vi.fn(async () => []) };
});

// 本机 .env 没配 LLM 凭据 → 换成一份假的，避免跑批在「没凭据」那一步就挂掉
vi.mock('../../src/services/llm-settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/llm-settings')>();
  return {
    ...actual,
    resolveLlmSettings: vi.fn(async () => ({
      apiKey: 'fake-key-for-test',
      baseUrl: 'https://example.invalid',
      model: 'fake-model',
      provider: 'anthropic',
      temperature: 0.2,
      maxOutputTokens: 512,
      retrievalTopK: 3,
      maxHistoryTurns: 2,
      retrievalTokenBudget: 2000,
      contextTokenBudget: 4000,
      summaryTokenBudget: 1000,
      summaryEnabled: false,
      maxInputChars: 2000,
      thinkingBudgetTokens: 0,
      rerankEnabled: false,
      queryRewriteEnabled: false,
      promptCacheEnabled: false,
      promptVersion: state.activePromptVersion,
      modelEntryId: null,
      source: 'process-default' as const,
      degraded: null,
      fallback: null,
    })),
  };
});

import { startEvaluationRun } from '../../src/services/evaluation';

const MARKER_A = 'AB_MARKER_VERSION_A';
const MARKER_B = 'AB_MARKER_VERSION_B';

/** 造一个带唯一标记的提示词版本 —— 靠标记判断「跑的到底是哪一版」 */
function promptContent(marker: string): string {
  return [
    '你是「{{tenantName}}」的客服助手。',
    marker,
    '请用中文回答。',
  ].join('\n');
}

describe('A/B 对比 · 跑批指定提示词版本 + 对比接口', () => {
  let http: AllHttp;
  let customerAgainstAdmin: ReturnType<typeof adminHttp>;
  let acmeId = '';
  let datasetId = '';
  let itemId = '';
  const createdPromptVersions: string[] = [];
  const createdRunIds: string[] = [];

  /** 等后台跑批跑完（跑批是异步的，接口立刻返回） */
  const waitRun = async (runId: string): Promise<EvaluationRun | null> => {
    for (let i = 0; i < 100; i += 1) {
      const row = await EvaluationRun.findOne({ where: { id: runId } });
      if (row !== null && (row.status === 'completed' || row.status === 'failed')) {
        return row;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return EvaluationRun.findOne({ where: { id: runId } });
  };

  beforeAll(async () => {
    getSequelize();
    http = await allHttpFromTokensFile();
    const tokens = await readTokensFile();
    customerAgainstAdmin = adminHttp(tokens.acmeCustomer);

    const acme = await Tenant.findOne({ where: { code: 'acme' } });
    acmeId = acme?.id ?? '';

    // 造两个提示词版本 + 一个 1 题的评测集
    for (const [version, marker] of [
      ['ab-v-a', MARKER_A],
      ['ab-v-b', MARKER_B],
    ] as const) {
      const created = await PromptVersion.create({
        tenant_id: acmeId,
        version,
        status: 'draft',
        content: promptContent(marker),
        description: 'A/B 对比测试用',
        created_by: 'test',
      });
      createdPromptVersions.push(created.id);
    }

    const dataset = await EvaluationDataset.create({
      tenant_id: acmeId,
      name: 'A/B 对比测试集',
      version: 'v1',
      description: '测试用',
      item_count: 1,
      created_by: 'test',
    });
    datasetId = dataset.id;

    const item = await EvaluationItem.create({
      tenant_id: acmeId,
      dataset_id: datasetId,
      question: '年假可以跨年结转吗？',
      reference_answer: '最多可结转 5 天',
      scenario: '年假',
      difficulty: 'medium',
    });
    itemId = item.id;
  });

  afterAll(async () => {
    for (const runId of createdRunIds) {
      await EvaluationResult.destroy({ where: { run_id: runId } });
    }
    await EvaluationRun.destroy({ where: { dataset_id: datasetId } });
    await EvaluationResult.destroy({ where: { run_id: createdRunIds } });
    await EvaluationItem.destroy({ where: { dataset_id: datasetId } });
    await EvaluationDataset.destroy({ where: { id: datasetId } });
    if (createdPromptVersions.length > 0) {
      await PromptVersion.destroy({ where: { id: createdPromptVersions } });
    }
  });

  // ===== 1. 跑批指定提示词版本（服务层 · 零成本）=====

  describe('跑批 · 指定提示词版本', () => {
    it('指定版本 → 跑的确实是那一版（看生成时收到的 system 提示词）', async () => {
      state.captured.length = 0;
      state.activePromptVersion = null;

      const run = await startEvaluationRun(acmeId, null, datasetId, {
        promptVersion: 'ab-v-a',
      });
      createdRunIds.push(run.id);

      const finished = await waitRun(run.id);
      expect(finished?.status).toBe('completed');
      // run 行记的就是指定的那一版
      expect(finished?.prompt_version).toBe('ab-v-a');

      // 生成回答时收到的 system 提示词里带着 A 版的标记
      const answerCalls = state.captured.filter((c) => !c.system.includes('评测裁判'));
      expect(answerCalls.length).toBeGreaterThan(0);
      expect(answerCalls.some((c) => c.system.includes(MARKER_A))).toBe(true);
      expect(answerCalls.some((c) => c.system.includes(MARKER_B))).toBe(false);
    });

    it('不指定版本 → 跟随租户当前生效的那一版', async () => {
      state.captured.length = 0;
      state.activePromptVersion = 'ab-v-b';

      const run = await startEvaluationRun(acmeId, null, datasetId, {});
      createdRunIds.push(run.id);

      const finished = await waitRun(run.id);
      expect(finished?.status).toBe('completed');
      expect(finished?.prompt_version).toBe('ab-v-b');

      const answerCalls = state.captured.filter((c) => !c.system.includes('评测裁判'));
      expect(answerCalls.some((c) => c.system.includes(MARKER_B))).toBe(true);
      expect(answerCalls.some((c) => c.system.includes(MARKER_A))).toBe(false);
    });

    it('显式指定内置默认 → 跑的是内置默认提示词', async () => {
      state.captured.length = 0;
      state.activePromptVersion = 'ab-v-b';

      const run = await startEvaluationRun(acmeId, null, datasetId, {
        promptVersion: null,
      });
      createdRunIds.push(run.id);

      const finished = await waitRun(run.id);
      expect(finished?.status).toBe('completed');
      // 内置默认的版本号是 chat-v1
      expect(finished?.prompt_version).toBe('chat-v1');

      const answerCalls = state.captured.filter((c) => !c.system.includes('评测裁判'));
      expect(answerCalls.some((c) => c.system.includes(MARKER_B))).toBe(false);
    });

    it('指定的版本不存在 → 直接抛错，不静默回落默认', async () => {
      await expect(
        startEvaluationRun(acmeId, null, datasetId, { promptVersion: 'no-such-version' }),
      ).rejects.toThrow(/不存在/);
    });

    it('别人的版本号也不行（跨租户）', async () => {
      const globex = await Tenant.findOne({ where: { code: 'globex' } });
      const other = await PromptVersion.create({
        tenant_id: globex?.id ?? '',
        version: 'globex-only-v',
        status: 'draft',
        content: promptContent('GLOBEX_MARKER'),
        created_by: 'test',
      });
      createdPromptVersions.push(other.id);

      await expect(
        startEvaluationRun(acmeId, null, datasetId, { promptVersion: 'globex-only-v' }),
      ).rejects.toThrow(/不存在/);
    });
  });

  // ===== 2. HTTP 层：指定不存在的版本 → 400 =====

  describe('POST /evaluation/runs · prompt_version 校验', () => {
    it('版本不存在 → 400（同步拒绝，不留半成品 run）', async () => {
      const before = await EvaluationRun.count({ where: { dataset_id: datasetId } });

      const res = await http.acmeAdmin.post(
        '/evaluation/runs',
        { dataset_id: datasetId, prompt_version: 'no-such-version-at-all' },
        { validateStatus: () => true },
      );
      expect(res.status).toBe(400);

      // 校验在 create 之前 → 不会留下一个跑不动的 run
      const after = await EvaluationRun.count({ where: { dataset_id: datasetId } });
      expect(after).toBe(before);
    });

    it('鉴权：customer token → 401', async () => {
      const res = await customerAgainstAdmin.post(
        '/evaluation/runs',
        { dataset_id: datasetId, prompt_version: 'ab-v-a' },
        { validateStatus: () => true },
      );
      expect(res.status).toBe(401);
    });
  });

  // ===== 3. HTTP 层：对比接口 =====

  describe('GET /evaluation/compare', () => {
    let runA = '';
    let runB = '';

    beforeAll(async () => {
      // 两条「跑批」：同一个评测集、同一道题，分数不同
      const a = await EvaluationRun.create({
        tenant_id: acmeId,
        dataset_id: datasetId,
        dataset_name: 'A/B 对比测试集',
        status: 'completed',
        prompt_version: 'ab-v-a',
        model: 'fake-model',
        provider: 'anthropic',
        total_items: 2,
        completed_items: 2,
        accuracy: 3,
        completeness: 3,
        style: 3,
        safety: 3,
        total_score: 3,
        total_tokens: 1000,
        total_cost: 0.01,
        started_at: new Date(),
        finished_at: new Date(),
      });
      const b = await EvaluationRun.create({
        tenant_id: acmeId,
        dataset_id: datasetId,
        dataset_name: 'A/B 对比测试集',
        status: 'completed',
        prompt_version: 'ab-v-b',
        model: 'fake-model',
        provider: 'anthropic',
        total_items: 2,
        completed_items: 2,
        accuracy: 4,
        completeness: 4,
        style: 4,
        safety: 4,
        total_score: 4,
        total_tokens: 1200,
        total_cost: 0.02,
        started_at: new Date(),
        finished_at: new Date(),
      });
      runA = a.id;
      runB = b.id;
      createdRunIds.push(runA, runB);

      const mk = async (
        runId: string,
        q: string,
        scores: { accuracy: number; completeness: number; style: number; safety: number },
      ): Promise<void> => {
        await EvaluationResult.create({
          run_id: runId,
          tenant_id: acmeId,
          item_id: itemId,
          question: q,
          answer: `回答：${q}`,
          reference_answer: null,
          scores,
          judge_reason: '测试理由',
          input_tokens: 100,
          output_tokens: 50,
          cost: 0.005,
          latency_ms: 100,
        });
      };

      // A：两题都 3 分；B：第一题 4 分（更好）、第二题 2 分（更差）
      await mk(runA, '年假可以跨年结转吗？', { accuracy: 3, completeness: 3, style: 3, safety: 3 });
      await mk(runA, '发票什么时候截止？', { accuracy: 3, completeness: 3, style: 3, safety: 3 });
      await mk(runB, '年假可以跨年结转吗？', { accuracy: 4, completeness: 4, style: 4, safety: 4 });
      await mk(runB, '发票什么时候截止？', { accuracy: 2, completeness: 2, style: 2, safety: 2 });
    });

    it('返回汇总 + 逐题对比', async () => {
      const res = await http.acmeAdmin.get<{
        a: { id: string; prompt_version: string | null };
        b: { id: string; prompt_version: string | null };
        warnings: string[];
        dimensions: Array<{ key: string; a: number | null; b: number | null; delta: number | null }>;
        metrics: {
          total_tokens: { a: number; b: number; delta: number };
          total_cost: { a: number; b: number; delta: number };
          items: { a: number; b: number; matched: number };
        };
        item_stats: { better: number; worse: number; same: number };
        items: Array<{
          question: string;
          delta: number | null;
          verdict: string;
          a: { scores: { accuracy: number } } | null;
          b: { scores: { accuracy: number } } | null;
        }>;
      }>('/evaluation/compare', { params: { run_id_a: runA, run_id_b: runB } });

      expect(res.status).toBe(200);
      expect(res.data.a.id).toBe(runA);
      expect(res.data.b.id).toBe(runB);

      // 汇总：总分 3 → 4，差值 +1
      const total = res.data.dimensions.find((d) => d.key === 'total_score');
      expect(total?.a).toBe(3);
      expect(total?.b).toBe(4);
      expect(total?.delta).toBe(1);

      // 成本 / token 也带差值
      expect(res.data.metrics.total_tokens.delta).toBe(200);
      expect(res.data.metrics.total_cost.delta).toBeCloseTo(0.01, 6);
      expect(res.data.metrics.items.matched).toBe(2);

      // 逐题：一题更好、一题更差
      expect(res.data.item_stats.better).toBe(1);
      expect(res.data.item_stats.worse).toBe(1);
      expect(res.data.items).toHaveLength(2);
      const better = res.data.items.find((i) => i.question.includes('年假'));
      expect(better?.verdict).toBe('better');
      expect(better?.delta).toBe(1);
      const worse = res.data.items.find((i) => i.question.includes('发票'));
      expect(worse?.verdict).toBe('worse');
      expect(worse?.delta).toBe(-1);
    });

    it('同一个版本对比两次 → 提醒「差异不来自提示词」', async () => {
      const res = await http.acmeAdmin.get<{ warnings: string[] }>('/evaluation/compare', {
        params: { run_id_a: runA, run_id_b: runA },
      });
      expect(res.status).toBe(200);
      expect(res.data.warnings.some((w) => w.includes('同一个提示词版本'))).toBe(true);
    });

    it('跨租户隔离：globex admin 拿 acme 的 run id → 404', async () => {
      const res = await http.globAdmin.get('/evaluation/compare', {
        params: { run_id_a: runA, run_id_b: runB },
        validateStatus: () => true,
      });
      expect(res.status).toBe(404);
    });

    it('少给参数 → 400', async () => {
      const res = await http.acmeAdmin.get('/evaluation/compare', {
        params: { run_id_a: runA },
        validateStatus: () => true,
      });
      expect(res.status).toBe(400);
    });

    it('鉴权：customer token → 401', async () => {
      const res = await customerAgainstAdmin.get('/evaluation/compare', {
        params: { run_id_a: runA, run_id_b: runB },
        validateStatus: () => true,
      });
      expect(res.status).toBe(401);
    });
  });
});
