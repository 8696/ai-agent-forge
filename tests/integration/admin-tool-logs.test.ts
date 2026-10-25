/**
 * tests/integration/admin-tool-logs.test.ts
 * 对应 src/gateway/admin/tool-log-routes.ts（工具调用记录）
 * 详见 docs/12-b-需求-ai对话能力.md §B3
 *
 * ⚠️ 工具调用的**写入**路径要真调 LLM 才能走到（见 tool-calling-e2e.test.ts，
 *    那个文件由 CHAT_LLM_E2E=1 控制）。本文件测的是**读侧**：
 *    直接往表里写一行，再验列表接口的筛选、分页、跨租户隔离。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import axios from 'axios';
import { ToolCallLog, Tenant } from '../../src/models';
import { apiBase, allHttpFromTokensFile, type AllHttp } from '../helpers';

const BASE = apiBase();

interface ToolCallLogItem {
  id: string;
  tool_name: string;
  builtin: string | null;
  status: string;
  args: unknown;
  output: unknown;
  error: string | null;
  duration_ms: number;
  created_at: string;
}

/** 拿 acme 租户的 id（seed 建的租户） */
async function tenantIdOf(code: string): Promise<string> {
  const t = await Tenant.findOne({ where: { code } });
  if (t === null) {
    throw new Error(`租户 ${code} 不存在`);
  }
  return t.id;
}

describe('admin-tool-logs-routes', () => {
  let http: AllHttp;
  let acmeId: string;
  let globexId: string;
  const createdIds: string[] = [];

  beforeAll(async () => {
    http = await allHttpFromTokensFile();
    acmeId = await tenantIdOf('acme');
    globexId = await tenantIdOf('globex');
  });

  afterAll(async () => {
    for (const id of createdIds) {
      await ToolCallLog.destroy({ where: { id } });
    }
  });

  /** 往表里塞一条调用记录（读侧测试不需要真调 LLM） */
  const insert = async (
    tenantId: string,
    over: Partial<ToolCallLog> = {},
  ): Promise<ToolCallLog> => {
    const row = await ToolCallLog.create({
      tenant_id: tenantId,
      user_id: null,
      session_id: null,
      message_id: null,
      tool_call_id: `call-${Math.random().toString(36).slice(2, 10)}`,
      tool_name: 'query_order_status',
      builtin: 'query_order_status',
      status: 'ok',
      args: { order_no: 'SO-TEST-1' },
      output: { order_no: 'SO-TEST-1', status: '已发货' },
      error: null,
      duration_ms: 12,
      trace_id: null,
      ...over,
    });
    createdIds.push(row.id);
    return row;
  };

  describe('GET /tool-logs · 列表', () => {
    it('200 + 返回数组和分页信息', async () => {
      const r = await http.acmeAdmin.get('/tool-logs');
      expect(r.status).toBe(200);
      const body = r.data as { logs: ToolCallLogItem[]; pagination: { total: number } };
      expect(Array.isArray(body.logs)).toBe(true);
      expect(typeof body.pagination.total).toBe('number');
    });

    it('401 无 token', async () => {
      const r = await axios.get(`${BASE}/api/v1/admin/tool-logs`, { validateStatus: () => true });
      expect(r.status).toBe(401);
    });
  });

  describe('内容与筛选', () => {
    it('返回里带请求参数和响应参数 + 时间 + 耗时', async () => {
      const row = await insert(acmeId, {
        tool_name: 'query_order_status',
        args: { order_no: 'SO-TEST-1' },
        output: { order_no: 'SO-TEST-1', status: '已发货' },
      });
      const r = await http.acmeAdmin.get('/tool-logs?page_size=100');
      expect(r.status).toBe(200);
      const body = r.data as { logs: ToolCallLogItem[] };
      const hit = body.logs.find((l) => l.id === row.id);
      expect(hit, '刚写的记录应该出现在列表里').toBeDefined();
      expect(hit?.args).toEqual({ order_no: 'SO-TEST-1' });
      expect(hit?.output).toEqual({ order_no: 'SO-TEST-1', status: '已发货' });
      expect(typeof hit?.duration_ms).toBe('number');
      expect(typeof hit?.created_at).toBe('string');
    });

    it('按工具名筛', async () => {
      const row = await insert(acmeId, { tool_name: 'query_coupon_info' });
      const r = await http.acmeAdmin.get('/tool-logs?tool_name=query_coupon_info&page_size=100');
      expect(r.status).toBe(200);
      const body = r.data as { logs: ToolCallLogItem[] };
      expect(body.logs.some((l) => l.id === row.id)).toBe(true);
      for (const log of body.logs) {
        expect(log.tool_name).toBe('query_coupon_info');
      }
    });

    it('按状态筛', async () => {
      const row = await insert(acmeId, { status: 'error', error: '后端炸了' });
      const r = await http.acmeAdmin.get('/tool-logs?status=error&page_size=100');
      expect(r.status).toBe(200);
      const body = r.data as { logs: ToolCallLogItem[] };
      expect(body.logs.some((l) => l.id === row.id)).toBe(true);
      for (const log of body.logs) {
        expect(log.status).toBe('error');
      }
    });

    it('关键词搜（入参 / 返回值里包含）', async () => {
      const row = await insert(acmeId, {
        args: { order_no: 'SO-KEYWORD-9' },
        output: { order_no: 'SO-KEYWORD-9' },
      });
      const r = await http.acmeAdmin.get('/tool-logs?keyword=SO-KEYWORD-9&page_size=100');
      expect(r.status).toBe(200);
      const body = r.data as { logs: ToolCallLogItem[] };
      expect(body.logs.some((l) => l.id === row.id)).toBe(true);
    });
  });

  describe('跨租户隔离（A1 红线）', () => {
    it('B 租户 admin 看不到 A 租户的调用记录', async () => {
      const row = await insert(acmeId, { tool_name: 'acme_only_marker' });
      const r = await http.globAdmin.get('/tool-logs?page_size=100');
      expect(r.status).toBe(200);
      const body = r.data as { logs: ToolCallLogItem[] };
      expect(body.logs.some((l) => l.id === row.id)).toBe(false);
      expect(body.logs.some((l) => l.tool_name === 'acme_only_marker')).toBe(false);
    });

    it('A 租户看得到自己写的（B 租户写的看不到）', async () => {
      const globexRow = await insert(globexId, { tool_name: 'globex_only_marker' });
      const r = await http.acmeAdmin.get('/tool-logs?page_size=100');
      expect(r.status).toBe(200);
      const body = r.data as { logs: ToolCallLogItem[] };
      expect(body.logs.some((l) => l.id === globexRow.id)).toBe(false);
      expect(body.logs.some((l) => l.tool_name === 'globex_only_marker')).toBe(false);
    });
  });

  describe('GET /tool-logs/names · 工具名下拉', () => {
    it('200 + 返回数组', async () => {
      await insert(acmeId, { tool_name: 'query_shipping_track' });
      const r = await http.acmeAdmin.get('/tool-logs/names');
      expect(r.status).toBe(200);
      const names = (r.data as { names: string[] }).names;
      expect(Array.isArray(names)).toBe(true);
      expect(names).toContain('query_shipping_track');
    });
  });

  describe('GET /tool-logs/:id · 详情', () => {
    it('200 + 返回单条', async () => {
      const row = await insert(acmeId);
      const r = await http.acmeAdmin.get(`/tool-logs/${row.id}`);
      expect(r.status).toBe(200);
      expect((r.data as { log: { id: string } }).log.id).toBe(row.id);
    });

    it('404 取不存在的', async () => {
      const r = await http.acmeAdmin.get('/tool-logs/not-a-real-id', {
        validateStatus: () => true,
      });
      expect(r.status).toBe(404);
    });

    it('404 取别的租户的', async () => {
      const row = await insert(globexId);
      const r = await http.acmeAdmin.get(`/tool-logs/${row.id}`, {
        validateStatus: () => true,
      });
      expect(r.status).toBe(404);
    });
  });
});
