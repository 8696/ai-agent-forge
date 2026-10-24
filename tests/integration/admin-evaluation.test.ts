import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Op } from 'sequelize';
import { allHttpFromTokensFile, adminHttp, readTokensFile, type AllHttp } from '../helpers';
import { getSequelize } from '../../src/db';
import { EvaluationDataset, EvaluationItem, EvaluationResult, EvaluationRun } from '../../src/models';

/**
 * 评测（D1）的端到端验证 —— **只覆盖零 LLM 成本的部分**
 *
 * 覆盖：评测集 CRUD + JSONL 解析 + 跨租户隔离 + 鉴权。
 *
 * ⚠️ **不覆盖「跑批」**：跑批每题要调 2 次 LLM（生成 + 裁判），会产生真实费用。
 *    跑批链路的纯逻辑（JSONL 解析 / 裁判输出解析 / 分数聚合）在
 *    tests/unit/evaluation-parse.test.ts 里覆盖；真跑一次请在后台手动点。
 */

const JSONL = [
  '{"question":"年假可以跨年结转吗？","reference_answer":"最多可结转 5 天","scenario":"年假","difficulty":"medium"}',
  '{"question":"发票什么时候截止提交？","reference_answer":"次月 15 日前","scenario":"报销","difficulty":"easy"}',
  '{ 这行是坏的',
  '{"question":"没有参考答案的题"}',
].join('\n');

describe('评测 · 端到端（零 LLM 成本）', () => {
  let http: AllHttp;
  const createdIds: string[] = [];
  /**
   * 拿 customer 的 token 打 admin 路由 —— 验证跨子系统鉴权。
   * 不能用 http.acmeCustomer：它的 baseURL 是 /api/v1/customer，
   * 打过去根本到不了 admin 路由（会拿到 404 而不是 401，测的就不是鉴权了）。
   */
  let customerAgainstAdmin: ReturnType<typeof adminHttp>;

  beforeAll(async () => {
    getSequelize();
    http = await allHttpFromTokensFile();
    const tokens = await readTokensFile();
    customerAgainstAdmin = adminHttp(tokens.acmeCustomer);
  });

  afterAll(async () => {
    for (const id of createdIds) {
      const runs = await EvaluationRun.findAll({
        where: { dataset_id: id },
        attributes: ['id'],
      });
      if (runs.length > 0) {
        await EvaluationResult.destroy({
          where: { run_id: { [Op.in]: runs.map((r) => r.id) } },
        });
      }
      await EvaluationRun.destroy({ where: { dataset_id: id } });
      await EvaluationItem.destroy({ where: { dataset_id: id } });
      await EvaluationDataset.destroy({ where: { id } });
    }
  });

  // ===== 评测集 CRUD =====

  describe('POST /evaluation/datasets', () => {
    it('用 JSONL 建评测集：好行入库、坏行被跳过', async () => {
      const res = await http.acmeAdmin.post<{
        id: string;
        name: string;
        item_count: number;
        skipped: Array<{ line: number; message: string }>;
      }>('/evaluation/datasets', {
        name: '测试评测集',
        version: 'v1',
        jsonl: JSONL,
      });
      expect(res.status).toBe(201);
      expect(res.data.item_count).toBe(3); // 4 行里 1 行坏
      expect(res.data.skipped).toHaveLength(1);
      expect(res.data.skipped[0]?.line).toBe(3);
      createdIds.push(res.data.id);
    });

    it('整份都是坏行 → 400（不能建出一个空评测集）', async () => {
      const res = await http.acmeAdmin.post(
        '/evaluation/datasets',
        {
          name: '全坏',
          jsonl: ['{ 坏', 'not json at all'].join('\n'),
        },
        { validateStatus: () => true },
      );
      expect(res.status).toBe(400);
    });

    it('不给 items 也不给 jsonl → 400', async () => {
      const res = await http.acmeAdmin.post(
        '/evaluation/datasets',
        { name: '空的' },
        { validateStatus: () => true },
      );
      expect(res.status).toBe(400);
    });

    it('items 和 jsonl 同时给 → 400', async () => {
      const res = await http.acmeAdmin.post(
        '/evaluation/datasets',
        {
          name: '重复给',
          jsonl: '{"question":"q"}',
          items: [{ question: 'q' }],
        },
        { validateStatus: () => true },
      );
      expect(res.status).toBe(400);
    });

    it('鉴权：customer token → 401', async () => {
      const res = await customerAgainstAdmin.post(
        '/evaluation/datasets',
        {
          name: 'x',
          jsonl: '{"question":"q"}',
        },
        { validateStatus: () => true },
      );
      expect(res.status).toBe(401);
    });
  });

  describe('GET /evaluation/datasets', () => {
    it('列出本租户的评测集（含条数和最近分数）', async () => {
      const res = await http.acmeAdmin.get<{
        datasets: Array<{ id: string; name: string; item_count: number; latest_score: number | null }>;
      }>('/evaluation/datasets');
      expect(res.status).toBe(200);
      const mine = res.data.datasets.find((d) => d.name === '测试评测集');
      expect(mine).toBeDefined();
      expect(mine?.item_count).toBe(3);
      // 没跑过 → latest_score 为 null
      expect(mine?.latest_score).toBeNull();
    });

    it('跨租户隔离：globex admin 看不到 acme 的评测集', async () => {
      const acmeRes = await http.acmeAdmin.get<{ datasets: Array<{ id: string }> }>(
        '/evaluation/datasets',
      );
      const acmeIds = new Set(acmeRes.data.datasets.map((d) => d.id));
      const globRes = await http.globAdmin.get<{ datasets: Array<{ id: string }> }>(
        '/evaluation/datasets',
      );
      expect(globRes.data.datasets.filter((d) => acmeIds.has(d.id))).toHaveLength(0);
    });
  });

  describe('GET /evaluation/datasets/:id', () => {
    it('返回评测集 + 题目明细', async () => {
      const list = await http.acmeAdmin.get<{ datasets: Array<{ id: string; name: string }> }>(
        '/evaluation/datasets',
      );
      const target = list.data.datasets.find((d) => d.name === '测试评测集');
      const res = await http.acmeAdmin.get<{
        dataset: { item_count: number };
        items: Array<{ question: string; reference_answer: string | null; difficulty: string | null }>;
      }>(`/evaluation/datasets/${target?.id ?? ''}`);
      expect(res.status).toBe(200);
      expect(res.data.dataset.item_count).toBe(3);
      expect(res.data.items).toHaveLength(3);
      expect(res.data.items.map((i) => i.question)).toContain('年假可以跨年结转吗？');
      // 没有参考答案的那条 → null
      expect(res.data.items.find((i) => i.question === '没有参考答案的题')?.reference_answer).toBeNull();
    });

    it('跨租户：globex admin 拿 acme 的评测集 id → 404', async () => {
      const list = await http.acmeAdmin.get<{ datasets: Array<{ id: string; name: string }> }>(
        '/evaluation/datasets',
      );
      const target = list.data.datasets.find((d) => d.name === '测试评测集');
      const res = await http.globAdmin.get(`/evaluation/datasets/${target?.id ?? ''}`, {
        validateStatus: () => true,
      });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /evaluation/datasets/:id', () => {
    it('删掉评测集（连题目一起）', async () => {
      const created = await http.acmeAdmin.post<{ id: string }>('/evaluation/datasets', {
        name: '待删除',
        jsonl: '{"question":"临时题"}',
      });
      expect(created.status).toBe(201);

      const res = await http.acmeAdmin.delete(`/evaluation/datasets/${created.data.id}`, {
        validateStatus: () => true,
      });
      expect(res.status).toBe(204);

      const items = await EvaluationItem.findAll({
        where: { dataset_id: created.data.id },
      });
      expect(items).toHaveLength(0);
    });

    it('删不存在的评测集 → 404', async () => {
      const res = await http.acmeAdmin.delete('/evaluation/datasets/does-not-exist-id', {
        validateStatus: () => true,
      });
      expect(res.status).toBe(404);
    });
  });

  // ===== 跑批列表（只验证读，不触发真实跑批）=====

  describe('GET /evaluation/runs', () => {
    it('返回本租户的跑批列表 + 分页', async () => {
      const res = await http.acmeAdmin.get<{
        runs: unknown[];
        pagination: { total: number };
      }>('/evaluation/runs');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.data.runs)).toBe(true);
      expect(typeof res.data.pagination.total).toBe('number');
    });

    it('鉴权：customer token → 401', async () => {
      const res = await customerAgainstAdmin.get('/evaluation/runs', {
        validateStatus: () => true,
      });
      expect(res.status).toBe(401);
    });
  });

  describe('POST /evaluation/runs', () => {
    it('评测集不存在 → 400（请求体里的 id 不合法，不是 404）', async () => {
      const res = await http.acmeAdmin.post(
        '/evaluation/runs',
        { dataset_id: 'not-a-real-id' },
        { validateStatus: () => true },
      );
      expect(res.status).toBe(400);
    });

    it('鉴权：customer token → 401', async () => {
      const res = await customerAgainstAdmin.post(
        '/evaluation/runs',
        { dataset_id: 'x' },
        { validateStatus: () => true },
      );
      expect(res.status).toBe(401);
    });
  });
});
