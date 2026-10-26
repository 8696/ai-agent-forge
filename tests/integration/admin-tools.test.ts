/**
 * tests/integration/admin-tools.test.ts
 * 对应 src/gateway/admin/tool-routes.ts（5 个端点）
 * 详见 docs/12-c-需求-管理员可配置.md §C2、docs/12-b-需求-ai对话能力.md §B3
 */
import { describe, it, expect, beforeAll } from 'vitest';
import axios from 'axios';
import { apiBase, allHttpFromTokensFile, type AllHttp } from '../helpers';

const BASE = apiBase();

interface ToolItem {
  id: string;
  name: string;
  description: string | null;
  type: string;
  builtin: string | null;
  builtin_label: string | null;
  enabled: boolean;
  requires_confirmation: boolean;
}

describe('admin-tools-routes', () => {
  let http: AllHttp;

  beforeAll(async () => {
    http = await allHttpFromTokensFile();
  });

  /** 建一个工具并返回它（测完要删） */
  const createTool = async (
    client = http.acmeAdmin,
    name = `test_tool_${Date.now()}`,
    body: Record<string, unknown> = {},
  ): Promise<ToolItem> => {
    const r = await client.post(
      '/tools',
      { name, type: 'builtin', builtin: 'query_order_status', ...body },
      { validateStatus: () => true },
    );
    expect(r.status).toBe(201);
    return (r.data as { tool: ToolItem }).tool;
  };

  const deleteTool = async (id: string, client = http.acmeAdmin): Promise<void> => {
    await client.delete(`/tools/${id}`, { validateStatus: () => true });
  };

  describe('GET /tools · 列工具', () => {
    it('200 + 返回数组', async () => {
      const r = await http.acmeAdmin.get('/tools');
      expect(r.status).toBe(200);
      expect(Array.isArray((r.data as { tools: ToolItem[] }).tools)).toBe(true);
    });

    it('401 无 token', async () => {
      const r = await axios.get(`${BASE}/api/v1/admin/tools`, { validateStatus: () => true });
      expect(r.status).toBe(401);
    });
  });

  describe('GET /tools/builtins · 内置工具清单', () => {
    it('200 + 8 个内置工具（电商客服场景）', async () => {
      const r = await http.acmeAdmin.get('/tools/builtins');
      expect(r.status).toBe(200);
      const builtins = (r.data as { builtins: Array<{ key: string; sensitive: boolean }> })
        .builtins;
      // ⚠️ 2026-10-26 从 6 个变成 8 个：B5 工作流补了两个敏感工具
      // （update_shipping_address / create_after_sale_ticket）
      expect(builtins).toHaveLength(8);
      expect(builtins.map((b) => b.key)).toContain('submit_refund_request');
      expect(builtins.find((b) => b.key === 'submit_refund_request')?.sensitive).toBe(true);
      // 新增的两个也是敏感工具（会动数据，要用户点头）
      expect(builtins.find((b) => b.key === 'update_shipping_address')?.sensitive).toBe(true);
      expect(builtins.find((b) => b.key === 'create_after_sale_ticket')?.sensitive).toBe(true);
    });
  });

  describe('POST /tools · 注册工具', () => {
    it('201 + 返回工具', async () => {
      const tool = await createTool();
      expect(tool.id.length).toBeGreaterThan(0);
      expect(tool.enabled).toBe(true);
      expect(tool.builtin).toBe('query_order_status');
      // 描述没填 → 用内置实现的默认描述
      expect((tool.description ?? '').length).toBeGreaterThan(0);
      await deleteTool(tool.id);
    });

    it('201 + 自定义描述（这是租户「调教模型」的手柄）', async () => {
      const tool = await createTool(http.acmeAdmin, `test_tool_${Date.now()}`, {
        description: '查这个门店的订单状态',
      });
      expect(tool.description).toBe('查这个门店的订单状态');
      await deleteTool(tool.id);
    });

    it('400 同名（工具名租户内唯一）', async () => {
      const name = `dup_tool_${Date.now()}`;
      const tool = await createTool(http.acmeAdmin, name);
      const r = await http.acmeAdmin.post(
        '/tools',
        { name, type: 'builtin', builtin: 'query_order_status' },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(400);
      await deleteTool(tool.id);
    });

    it('400 名字不是合法标识符', async () => {
      const r = await http.acmeAdmin.post(
        '/tools',
        { name: '查订单状态', type: 'builtin', builtin: 'query_order_status' },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(400);
    });

    it('400 内置实现不存在', async () => {
      const r = await http.acmeAdmin.post(
        '/tools',
        { name: `bad_tool_${Date.now()}`, type: 'builtin', builtin: 'not_exists' },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(400);
    });

    it('201 http 类型（本地 mock）可注册', async () => {
      const r = await http.acmeAdmin.post(
        '/tools',
        {
          name: `http_tool_${Date.now()}`,
          type: 'http',
          url: 'https://api.example.com/orders/{id}',
          method: 'GET',
        },
        { validateStatus: () => true },
      );
      // ⚠️ 2026-10-26：http 类型改成「本地 mock」—— 保留 url/method 的配置形状，
      //    但平台不真的发请求（见 12-e 需求裁定表 #2）
      expect(r.status, 'http 类型应该能注册').toBe(201);
      await http.acmeAdmin.delete(`/tools/${r.data.tool.id}`, { validateStatus: () => true });
    });

    it('400 mcp 类型不做（跨系统：租户那边得自己跑 MCP server）', async () => {
      const r = await http.acmeAdmin.post(
        '/tools',
        { name: `mcp_tool_${Date.now()}`, type: 'mcp', url: 'https://example.com' },
        { validateStatus: () => true },
      );
      expect(r.status, 'mcp 类型应被拒').toBe(400);
    });

    it('400 http 类型缺 url', async () => {
      const r = await http.acmeAdmin.post(
        '/tools',
        { name: `http_tool_${Date.now()}`, type: 'http' },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(400);
    });
  });

  describe('PATCH /tools/:id · 改描述 / 启停', () => {
    it('200 改描述', async () => {
      const tool = await createTool();
      const r = await http.acmeAdmin.patch(
        `/tools/${tool.id}`,
        { description: '新的描述' },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(200);
      expect((r.data as { tool: ToolItem }).tool.description).toBe('新的描述');
      await deleteTool(tool.id);
    });

    it('200 禁用 → enabled=false', async () => {
      const tool = await createTool();
      const r = await http.acmeAdmin.patch(
        `/tools/${tool.id}`,
        { enabled: false },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(200);
      expect((r.data as { tool: ToolItem }).tool.enabled).toBe(false);
      await deleteTool(tool.id);
    });

    it('404 改不存在的工具', async () => {
      const r = await http.acmeAdmin.patch(
        '/tools/not-a-real-id',
        { enabled: false },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(404);
    });
  });

  describe('POST /tools/:id/test · 试连', () => {
    it('200 + 返回真实结果和耗时', async () => {
      const tool = await createTool();
      const r = await http.acmeAdmin.post(
        `/tools/${tool.id}/test`,
        {},
        { validateStatus: () => true },
      );
      expect(r.status).toBe(200);
      const body = r.data as { ok: boolean; output: unknown; took_ms: number };
      expect(body.ok).toBe(true);
      expect(body.took_ms).toBeGreaterThanOrEqual(0);
      expect(body.output).toBeDefined();
      await deleteTool(tool.id);
    });
  });

  describe('DELETE /tools/:id · 删', () => {
    it('204 + 删完列表里没有', async () => {
      const tool = await createTool();
      const del = await http.acmeAdmin.delete(`/tools/${tool.id}`, { validateStatus: () => true });
      expect(del.status).toBe(204);
      const list = await http.acmeAdmin.get('/tools');
      const ids = (list.data as { tools: ToolItem[] }).tools.map((t) => t.id);
      expect(ids).not.toContain(tool.id);
    });

    it('404 删不存在的工具', async () => {
      const r = await http.acmeAdmin.delete('/tools/not-a-real-id', {
        validateStatus: () => true,
      });
      expect(r.status).toBe(404);
    });
  });

  describe('跨租户隔离（A1 红线）', () => {
    it('B 租户 admin 看不到 A 租户的工具', async () => {
      const tool = await createTool(http.acmeAdmin);
      const list = await http.globAdmin.get('/tools');
      const ids = (list.data as { tools: ToolItem[] }).tools.map((t) => t.id);
      expect(ids).not.toContain(tool.id);
      await deleteTool(tool.id);
    });

    it('B 租户 admin 改 / 删 A 租户的工具 → 404', async () => {
      const tool = await createTool(http.acmeAdmin);
      const patch = await http.globAdmin.patch(
        `/tools/${tool.id}`,
        { enabled: false },
        { validateStatus: () => true },
      );
      expect(patch.status).toBe(404);
      const del = await http.globAdmin.delete(`/tools/${tool.id}`, { validateStatus: () => true });
      expect(del.status).toBe(404);
      await deleteTool(tool.id);
    });

    it('B 租户可以用自己的同名工具（唯一性是租户内的）', async () => {
      const name = `same_name_${Date.now()}`;
      const a = await createTool(http.acmeAdmin, name);
      const b = await createTool(http.globAdmin, name);
      expect(a.id).not.toBe(b.id);
      await deleteTool(a.id);
      await deleteTool(b.id, http.globAdmin);
    });
  });

  describe('审计留痕（C2 验收：注册 / 改 / 删 / 启停都写 audit_logs）', () => {
    const fetchAudit = async (action: string): Promise<
      Array<{ action: string; resource_type: string | null; resource_id: string | null }>
    > => {
      const r = await http.acmeAdmin.get(`/audit?action=${action}&page_size=10`);
      expect(r.status).toBe(200);
      return (r.data as { logs: Array<{ action: string; resource_type: string | null; resource_id: string | null }> })
        .logs;
    };

    it('注册 → TOOL_CREATED', async () => {
      const tool = await createTool();
      const logs = await fetchAudit('TOOL_CREATED');
      const hit = logs.find((l) => l.resource_id === tool.id);
      expect(hit, '注册工具后应有 TOOL_CREATED 审计记录').toBeDefined();
      expect(hit?.resource_type).toBe('tool');
      await deleteTool(tool.id);
    });

    it('改描述 → TOOL_UPDATED', async () => {
      const tool = await createTool();
      await http.acmeAdmin.patch(`/tools/${tool.id}`, { description: '改一下' });
      const logs = await fetchAudit('TOOL_UPDATED');
      expect(logs.find((l) => l.resource_id === tool.id)).toBeDefined();
      await deleteTool(tool.id);
    });

    it('启用 / 禁用 → TOOL_ENABLED / TOOL_DISABLED', async () => {
      const tool = await createTool();
      await http.acmeAdmin.patch(`/tools/${tool.id}`, { enabled: false });
      await http.acmeAdmin.patch(`/tools/${tool.id}`, { enabled: true });
      expect((await fetchAudit('TOOL_DISABLED')).find((l) => l.resource_id === tool.id)).toBeDefined();
      expect((await fetchAudit('TOOL_ENABLED')).find((l) => l.resource_id === tool.id)).toBeDefined();
      await deleteTool(tool.id);
    });

    it('删 → TOOL_DELETED', async () => {
      const tool = await createTool();
      await deleteTool(tool.id);
      const logs = await fetchAudit('TOOL_DELETED');
      expect(logs.find((l) => l.resource_id === tool.id)).toBeDefined();
    });
  });
});
