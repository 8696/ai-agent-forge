/**
 * tests/unit/tool-registry.test.ts
 * 对应 src/tools/builtin/*（内置 mock 工具的实现）
 * 详见 docs/12-b-需求-ai对话能力.md §B3
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  BUILTIN_TOOLS,
  getBuiltinTool,
  listBuiltinTools,
  type BuiltinToolContext,
} from '../../src/tools/builtin/registry';

const ctx = (tenantId: string): BuiltinToolContext => ({
  tenantId,
  sessionId: null,
  userId: null,
});

describe('内置工具注册表（电商客服场景）', () => {
  it('8 个内置工具都能按 key 取到', () => {
    // ⚠️ 2026-10-26 从 6 个变成 8 个：为了 B5 工作流补了两个「会动数据」的敏感工具
    // （update_shipping_address / create_after_sale_ticket）——
    // 它们是流程 modify_address / after_sale_ticket 的触发节点。
    expect(Object.keys(BUILTIN_TOOLS).sort()).toEqual([
      'create_after_sale_ticket',
      'list_knowledge_documents',
      'query_coupon_info',
      'query_order_status',
      'query_product_info',
      'query_shipping_track',
      'submit_refund_request',
      'update_shipping_address',
    ]);
    for (const key of Object.keys(BUILTIN_TOOLS)) {
      expect(getBuiltinTool(key)).toBeDefined();
    }
  });

  it('取不到就是 undefined（注册了指向已下架实现的记录时要能识别出来）', () => {
    expect(getBuiltinTool('not_exists')).toBeUndefined();
  });

  it('每个工具都有：描述 / 入参 schema / 样例入参', () => {
    for (const impl of listBuiltinTools()) {
      expect(impl.description.length).toBeGreaterThan(0);
      expect(impl.inputSchema).toBeDefined();
      expect(impl.sampleArgs).toBeDefined();
    }
  });

  it('提交退款申请 / 改地址 / 建工单是敏感工具，其余不是', () => {
    expect(getBuiltinTool('submit_refund_request')?.sensitive).toBe(true);
    expect(getBuiltinTool('update_shipping_address')?.sensitive).toBe(true);
    expect(getBuiltinTool('create_after_sale_ticket')?.sensitive).toBe(true);
    expect(getBuiltinTool('query_order_status')?.sensitive).toBe(false);
  });

  it('每个工具的描述里都说明了「什么时候该调它」（模型靠这个决定调不调）', () => {
    for (const impl of listBuiltinTools()) {
      expect(impl.description).toMatch(/当用户(问|说)/);
      expect(impl.description).toContain('时使用');
    }
  });

  describe('入参校验', () => {
    it('订单号为空 → 抛错', async () => {
      const impl = getBuiltinTool('query_order_status');
      await expect(impl?.execute(ctx('t1'), { order_no: '' })).rejects.toThrow();
    });

    it('运单号不是字符串 → 抛错', async () => {
      const impl = getBuiltinTool('query_shipping_track');
      await expect(impl?.execute(ctx('t1'), { tracking_no: 123 })).rejects.toThrow();
    });

    it('退款金额是负数 → 抛错', async () => {
      const impl = getBuiltinTool('submit_refund_request');
      await expect(
        impl?.execute(ctx('t1'), { order_no: 'SO-1', amount: -1, reason: 'x' }),
      ).rejects.toThrow();
    });

    it('退款金额过大 → 抛错', async () => {
      const impl = getBuiltinTool('submit_refund_request');
      await expect(
        impl?.execute(ctx('t1'), { order_no: 'SO-1', amount: 999999, reason: 'x' }),
      ).rejects.toThrow();
    });

    it('查商品：id 和关键词都不给 → 抛错（模型拿不到东西查）', async () => {
      const impl = getBuiltinTool('query_product_info');
      await expect(impl?.execute(ctx('t1'), {})).rejects.toThrow();
    });
  });

  describe('mock 数据的确定性', () => {
    it('同租户同单号 → 两次结果完全一样', async () => {
      const impl = getBuiltinTool('query_order_status');
      const a = await impl?.execute(ctx('tenant-a'), { order_no: 'SO-1' });
      const b = await impl?.execute(ctx('tenant-a'), { order_no: 'SO-1' });
      expect(a).toEqual(b);
    });

    it('不同租户同单号 → 结果不同（跨租户不会串数据）', async () => {
      const impl = getBuiltinTool('query_order_status');
      const a = await impl?.execute(ctx('tenant-a'), { order_no: 'SO-1' });
      const b = await impl?.execute(ctx('tenant-b'), { order_no: 'SO-1' });
      expect(a).not.toEqual(b);
    });

    it('不同单号 → 结果不同', async () => {
      const impl = getBuiltinTool('query_order_status');
      const a = await impl?.execute(ctx('tenant-a'), { order_no: 'SO-1' });
      const b = await impl?.execute(ctx('tenant-a'), { order_no: 'SO-2' });
      expect(a).not.toEqual(b);
    });

    it('查商品：同一个关键词 → 同一件商品（价格 / 库存都一样）', async () => {
      const impl = getBuiltinTool('query_product_info');
      const a = await impl?.execute(ctx('t1'), { keyword: '耳机' });
      const b = await impl?.execute(ctx('t1'), { keyword: '耳机' });
      expect(a).toEqual(b);
    });

    it('查商品：给了 id 就按 id 查（跟按关键词查是两件商品）', async () => {
      const impl = getBuiltinTool('query_product_info');
      const byId = await impl?.execute(ctx('t1'), { product_id: 'SKU-1' });
      const byKeyword = await impl?.execute(ctx('t1'), { keyword: '耳机' });
      expect((byId as { product_id: string }).product_id).toBe('SKU-1');
      expect(byId).not.toEqual(byKeyword);
    });

    it('查物流：轨迹节点按时间从早到晚排', async () => {
      const impl = getBuiltinTool('query_shipping_track');
      const out = (await impl?.execute(ctx('t1'), {
        tracking_no: 'SF1234567890',
      })) as { traces: Array<{ time: string }> };
      expect(out.traces.length).toBeGreaterThan(0);
      const times = out.traces.map((t) => t.time);
      expect([...times].sort()).toEqual(times);
    });

    it('查优惠：同一个用户 → 同一批券', async () => {
      const impl = getBuiltinTool('query_coupon_info');
      const a = await impl?.execute(ctx('t1'), { user_id: 'U10086' });
      const b = await impl?.execute(ctx('t1'), { user_id: 'U10086' });
      expect(a).toEqual(b);
      const out = a as { coupons: Array<{ status: string }>; usable_count: number };
      expect(out.coupons.length).toBeGreaterThan(0);
      expect(out.usable_count).toBe(out.coupons.filter((c) => c.status === '可用').length);
    });
  });

  describe('查知识库文档清单（真实数据那个）', () => {
    it('入参 schema 允许省略 keyword', () => {
      const impl = getBuiltinTool('list_knowledge_documents');
      const schema = impl?.inputSchema as z.ZodType;
      expect(schema.safeParse({}).success).toBe(true);
      expect(schema.safeParse({ keyword: 'abc' }).success).toBe(true);
    });
  });
});
