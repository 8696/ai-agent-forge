import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { allHttpFromTokensFile, adminHttp, readTokensFile, type AllHttp } from '../helpers';
import { getSequelize } from '../../src/db';
import { CostLog, Span, Tenant, Trace } from '../../src/models';

/**
 * 观测（D2）的端到端验证
 *
 * 本文件**不产生 LLM 费用**：trace / span / cost_log 直接往库里写，
 * 不走对话链路。验证的是「后台能不能看到这些数据」以及**跨租户隔离**。
 *
 * 前置条件：后端起在 3099（NODE_ENV=test PORT=3099 tsx src/server.ts）
 */

interface TraceRow {
  id: string;
  name: string;
  status: string;
  duration_ms: number;
  total_tokens: number;
  cost: number;
}

describe('观测 · 端到端', () => {
  let http: AllHttp;
  let acmeTenantId: string;
  let globexTenantId: string;
  const createdTraceIds: string[] = [];
  /**
   * 拿 customer 的 token 打 admin 路由 —— 验证跨子系统鉴权。
   * 不能用 http.acmeCustomer：它的 baseURL 是 /api/v1/customer，
   * 打过去根本到不了 admin 路由（会拿到 404 而不是 401，测的就不是鉴权了）。
   */
  let customerAgainstAdmin: ReturnType<typeof adminHttp>;

  const seedTrace = async (
    tenantId: string,
    name: string,
    status: 'success' | 'error',
    durationMs: number,
    token: number,
  ): Promise<TraceRow> => {
    // id 长度要 ≤ 36（traces.id 是 STRING(36)）
    const id = `tr-test-${Math.random().toString(36).slice(2, 12)}`;
    await Trace.create({
      id,
      tenant_id: tenantId,
      user_id: null,
      session_id: null,
      name,
      kind: 'chat',
      status,
      channel: 'web',
      provider: 'zhipu',
      model: 'glm-5.3',
      input_tokens: Math.floor(token / 2),
      output_tokens: Math.floor(token / 2),
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      total_tokens: token,
      cost: 0.0012,
      duration_ms: durationMs,
      error_message: status === 'error' ? '模型生成失败' : null,
      metadata: null,
      started_at: new Date(),
      ended_at: new Date(),
    });
    await Span.create({
      id: `sp-test-${Math.random().toString(36).slice(2, 12)}`,
      trace_id: id,
      tenant_id: tenantId,
      parent_span_id: null,
      name: 'llm.generate',
      kind: 'llm',
      status: status,
      duration_ms: Math.floor(durationMs / 2),
      input: { model: 'glm-5.3' },
      output: { output_tokens: Math.floor(token / 2) },
      error_message: null,
      started_at: new Date(),
      ended_at: new Date(),
    });
    await CostLog.create({
      tenant_id: tenantId,
      user_id: null,
      session_id: null,
      message_id: null,
      provider: 'zhipu',
      model: 'glm-5.3',
      input_tokens: Math.floor(token / 2),
      output_tokens: Math.floor(token / 2),
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      total_tokens: token,
      cost: 0.0012,
    });
    createdTraceIds.push(id);
    return { id, name, status, duration_ms: durationMs, total_tokens: token, cost: 0.0012 };
  };

  beforeAll(async () => {
    getSequelize();
    http = await allHttpFromTokensFile();
    const tokens = await readTokensFile();
    customerAgainstAdmin = adminHttp(tokens.acmeCustomer);
    const acme = await Tenant.findOne({ where: { code: 'acme' } });
    const globex = await Tenant.findOne({ where: { code: 'globex' } });
    if (acme === null || globex === null) throw new Error('fixture 租户不存在');
    acmeTenantId = acme.id;
    globexTenantId = globex.id;

    await seedTrace(acmeTenantId, 'chat.message', 'success', 1200, 1000);
    await seedTrace(acmeTenantId, 'chat.message', 'error', 3000, 500);
    await seedTrace(globexTenantId, 'chat.message', 'success', 800, 700);
  });

  afterAll(async () => {
    for (const id of createdTraceIds) {
      await Span.destroy({ where: { trace_id: id } });
      await Trace.destroy({ where: { id } });
    }
  });

  // ===== trace 列表 =====

  describe('GET /observability/traces', () => {
    it('返回本租户的 trace + 分页信息', async () => {
      const res = await http.acmeAdmin.get<{
        traces: Array<{ id: string; name: string; total_tokens: number }>;
        pagination: { total: number };
      }>('/observability/traces');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.data.traces)).toBe(true);
      expect(res.data.pagination.total).toBeGreaterThanOrEqual(2);
      // 至少能看到我们刚种的两条
      expect(res.data.traces.map((t) => t.name)).toContain('chat.message');
    });

    it('跨租户隔离：globex admin 看不到 acme 的 trace', async () => {
      const acmeRes = await http.acmeAdmin.get<{ traces: Array<{ id: string }> }>(
        '/observability/traces',
      );
      const acmeIds = new Set(acmeRes.data.traces.map((t) => t.id));
      const globRes = await http.globAdmin.get<{ traces: Array<{ id: string }> }>(
        '/observability/traces',
      );
      const overlap = globRes.data.traces.filter((t) => acmeIds.has(t.id));
      expect(overlap).toHaveLength(0);
    });

    it('按状态筛选：只看失败', async () => {
      const res = await http.acmeAdmin.get<{ traces: Array<{ status: string }> }>(
        '/observability/traces?status=error',
      );
      expect(res.status).toBe(200);
      expect(res.data.traces.length).toBeGreaterThanOrEqual(1);
      expect(res.data.traces.every((t) => t.status === 'error')).toBe(true);
    });

    it('鉴权：customer token 调 admin 端点 → 401', async () => {
      const res = await customerAgainstAdmin.get('/observability/traces', {
        validateStatus: () => true,
      });
      expect(res.status).toBe(401);
    });
  });

  // ===== trace 详情 =====

  describe('GET /observability/traces/:id', () => {
    it('返回 trace + span 时间线', async () => {
      const list = await http.acmeAdmin.get<{ traces: Array<{ id: string }> }>(
        '/observability/traces',
      );
      const target = list.data.traces.find((t) => t.id.startsWith('tr-test-'));
      expect(target).toBeDefined();

      const res = await http.acmeAdmin.get<{ trace: { id: string }; spans: Array<{ name: string }> }>(
        `/observability/traces/${target?.id ?? ''}`,
      );
      expect(res.status).toBe(200);
      expect(res.data.trace.id).toBe(target?.id);
      expect(res.data.spans.length).toBeGreaterThanOrEqual(1);
      expect(res.data.spans.map((s) => s.name)).toContain('llm.generate');
    });

    it('跨租户：拿 acme 的 trace id 给 globex admin → 404', async () => {
      const list = await http.acmeAdmin.get<{ traces: Array<{ id: string }> }>(
        '/observability/traces',
      );
      const target = list.data.traces.find((t) => t.id.startsWith('tr-test-'));
      const res = await http.globAdmin.get(`/observability/traces/${target?.id ?? ''}`, {
        validateStatus: () => true,
      });
      expect(res.status).toBe(404);
    });
  });

  // ===== 成本分析 =====

  describe('GET /observability/cost', () => {
    it('返回合计 + 按天趋势 + 按维度拆解', async () => {
      const res = await http.acmeAdmin.get<{
        totals: { calls: number; total_tokens: number; cost: number };
        series: Array<{ key: string; calls: number }>;
        breakdown: Array<{ key: string; label: string; calls: number }>;
        group_by: string;
      }>('/observability/cost?range=month&group_by=model');
      expect(res.status).toBe(200);
      expect(res.data.group_by).toBe('model');
      expect(res.data.totals.calls).toBeGreaterThanOrEqual(2);
      expect(res.data.series.length).toBeGreaterThanOrEqual(1);
      expect(res.data.breakdown.some((b) => b.key === 'glm-5.3')).toBe(true);
    });

    it('换个拆解维度也能返回（provider）', async () => {
      const res = await http.acmeAdmin.get<{ group_by: string; breakdown: unknown[] }>(
        '/observability/cost?range=month&group_by=provider',
      );
      expect(res.status).toBe(200);
      expect(res.data.group_by).toBe('provider');
      expect(Array.isArray(res.data.breakdown)).toBe(true);
    });

    it('鉴权：customer token → 401', async () => {
      const res = await customerAgainstAdmin.get('/observability/cost', {
        validateStatus: () => true,
      });
      expect(res.status).toBe(401);
    });
  });

  // ===== 汇总 =====

  describe('GET /observability/summary', () => {
    it('返回今日指标（对话数 / p95 / 成本 / 错误率）', async () => {
      const res = await http.acmeAdmin.get<{
        today: {
          conversations: number;
          p95_latency_ms: number;
          cost: number;
          error_rate: number;
          errors: number;
        };
        trend: unknown[];
      }>('/observability/summary');
      expect(res.status).toBe(200);
      expect(res.data.today.conversations).toBeGreaterThanOrEqual(2);
      expect(res.data.today.errors).toBeGreaterThanOrEqual(1);
      // 2 条里 1 条失败 → 错误率 0.5
      expect(res.data.today.error_rate).toBeGreaterThan(0);
      expect(res.data.today.cost).toBeGreaterThan(0);
      expect(Array.isArray(res.data.trend)).toBe(true);
    });

    it('鉴权：customer token → 401', async () => {
      const res = await customerAgainstAdmin.get('/observability/summary', {
        validateStatus: () => true,
      });
      expect(res.status).toBe(401);
    });
  });
});
