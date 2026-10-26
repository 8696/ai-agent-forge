/**
 * tests/integration/prompt-regression.test.ts
 * 对应 src/services/prompt-regression.ts（D1「prompt 改动自动跑小规模回归」）
 * 详见 docs/12-d-需求-运维稳定.md §D1
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { allHttpFromTokensFile, type AllHttp } from '../helpers';
import { getSequelize } from '../../src/db';
import { EvaluationRun, Tenant } from '../../src/models';
import {
  PROMPT_REGRESSION_MAX_ITEMS,
  triggerPromptRegression,
  triggerPromptRegressionSafe,
} from '../../src/services/prompt-regression';

const JSONL = [
  JSON.stringify({
    question: '退货政策是怎样的？',
    reference_answer: '7 天无理由，运费非质量原因由买家承担。',
  }),
].join('\n');

describe('D1 · 提示词发布自动回归', () => {
  let http: AllHttp;
  let acmeId = '';
  let globexId = '';
  let datasetId = '';

  beforeAll(async () => {
    getSequelize();
    http = await allHttpFromTokensFile();
    const acme = await Tenant.findOne({ where: { code: 'acme' } });
    const globex = await Tenant.findOne({ where: { code: 'globex' } });
    acmeId = acme?.id ?? '';
    globexId = globex?.id ?? '';
  });

  afterAll(async () => {
    if (datasetId !== '') {
      await EvaluationRun.destroy({ where: { dataset_id: datasetId } });
      await http.acmeAdmin.delete(`/evaluation/datasets/${datasetId}`, { validateStatus: () => true });
    }
  });

  it('租户没有评测集 → 不触发（提示词发布不能被回归拖垮）', async () => {
    const outcome = await triggerPromptRegression({
      tenantId: globexId,
      userId: null,
      promptVersion: 'v-test',
    });
    expect(outcome.triggered).toBe(false);
    expect(outcome.reason).toContain('评测集');
  });

  it('有评测集 → 触发一次小规模跑批（标记 + 只跑前 N 题）', async () => {
    // 建一个 1 题的评测集（listDatasets 按 created_at DESC 排 → 它会排在最前）
    const res = await http.acmeAdmin.post<{ id: string; item_count: number }>(
      '/evaluation/datasets',
      { name: '回归测试集', version: 'v1', jsonl: JSONL },
      { validateStatus: () => true },
    );
    expect(res.status).toBe(201);
    datasetId = res.data.id;
    expect(res.data.item_count).toBe(1);

    const outcome = await triggerPromptRegression({
      tenantId: acmeId,
      userId: null,
      promptVersion: 'v-test',
    });
    expect(outcome.triggered).toBe(true);
    expect(outcome.runId).toBeTruthy();

    const run = await EvaluationRun.findOne({ where: { id: outcome.runId } });
    expect(run).not.toBeNull();
    // ⚠️ 列名是 `run_trigger` —— `trigger` 是 MySQL 保留字
    expect(run?.run_trigger).toBe('prompt_regression');
    expect(run?.item_limit).toBe(PROMPT_REGRESSION_MAX_ITEMS);
    // 评测集只有 1 题 → 实际就跑 1 题（上限取 min）
    expect(run?.total_items).toBe(1);
  });

  it('手动跑的跑批标记仍是 manual（回归的标记不串味）', async () => {
    const res = await http.acmeAdmin.post<{ id: string }>(
      '/evaluation/runs',
      { dataset_id: datasetId },
      { validateStatus: () => true },
    );
    // ⚠️ 跑批是**异步**的 —— 接口立刻返回 202，实际工作在后台跑
    expect(res.status).toBe(202);
    const run = await EvaluationRun.findOne({ where: { id: res.data.id } });
    expect(run?.run_trigger).toBe('manual');
    expect(run?.item_limit).toBeNull();
    await EvaluationRun.destroy({ where: { id: res.data.id } });
  });

  it('Safe 版本：出错也吞掉（发布流程不受影响）', async () => {
    // 传一个不存在的租户 → 内部会抛，但 Safe 版本不往外抛
    await expect(
      triggerPromptRegressionSafe({
        tenantId: 'not-a-real-tenant',
        userId: null,
        promptVersion: 'v-test',
      }),
    ).resolves.toBeUndefined();
  });
});
