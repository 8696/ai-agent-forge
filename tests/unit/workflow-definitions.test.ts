/**
 * tests/unit/workflow-definitions.test.ts
 * 对应 src/workflows/types.ts（B5 工作流定义）
 * 详见 docs/12-b-需求-ai对话能力.md §B5.1
 *
 * **纯逻辑测试** —— 不碰数据库、不碰 LLM。
 * 这里守的是「流程定义本身自洽」：引用不能悬空、触发器不能撞车。
 * 引擎的实际行为由 tests/integration/workflow-missions.test.ts 验。
 */
import { describe, it, expect } from 'vitest';
import {
  WORKFLOWS,
  findFlowByTrigger,
  findFlowByType,
  findNode,
  findNodeByTool,
} from '../../src/workflows/types';

describe('B5 工作流定义', () => {
  it('三条流程都在，类型不重名', () => {
    expect(WORKFLOWS).toHaveLength(3);
    const types = WORKFLOWS.map((f) => f.type);
    expect(new Set(types).size).toBe(types.length);
    expect(types).toContain('refund_request');
    expect(types).toContain('modify_address');
    expect(types).toContain('after_sale_ticket');
  });

  it('触发工具全局唯一 —— 撞车了就分不清是哪条流程', () => {
    const triggers = WORKFLOWS.map((f) => f.trigger);
    expect(new Set(triggers).size).toBe(triggers.length);
  });

  it('触发器一定是「需要确认」的节点（发起流程本身就是有副作用的动作）', () => {
    for (const flow of WORKFLOWS) {
      const node = flow.nodes.find((n) => n.tool === flow.trigger);
      expect(node, `${flow.type} 的触发器不在节点表里`).toBeDefined();
      expect(node?.confirm, `${flow.type} 的触发器必须是 confirm 节点`).toBe(true);
    }
  });

  it('每个节点的 requires 都指向真实存在的节点（不能悬空）', () => {
    for (const flow of WORKFLOWS) {
      const ids = new Set(flow.nodes.map((n) => n.id));
      for (const node of flow.nodes) {
        for (const req of node.requires) {
          expect(ids.has(req), `${flow.type}/${node.id} 依赖了不存在的节点 ${req}`).toBe(true);
        }
      }
    }
  });

  it('没有自依赖、没有环（流程必须是线性的）', () => {
    for (const flow of WORKFLOWS) {
      const byId = new Map(flow.nodes.map((n) => [n.id, n]));

      /** 从 start 顺着 requires 能不能走回 goal */
      const canReach = (start: string, goal: string): boolean => {
        const visited = new Set<string>();
        const stack = [...(byId.get(start)?.requires ?? [])];
        while (stack.length > 0) {
          const cur = stack.pop() as string;
          if (cur === goal) {
            return true;
          }
          if (visited.has(cur)) {
            continue;
          }
          visited.add(cur);
          stack.push(...(byId.get(cur)?.requires ?? []));
        }
        return false;
      };

      for (const node of flow.nodes) {
        expect(node.requires).not.toContain(node.id);
        expect(canReach(node.id, node.id), `${flow.type}/${node.id} 能绕回自己（有环）`).toBe(false);
      }
    }
  });

  it('每个流程都有且只有一个 confirm 节点', () => {
    for (const flow of WORKFLOWS) {
      const confirms = flow.nodes.filter((n) => n.confirm);
      expect(confirms, `${flow.type} 的 confirm 节点数不对`).toHaveLength(1);
    }
  });

  it('查节点的三个入口都对得上', () => {
    const refund = findFlowByType('refund_request');
    expect(refund).toBeDefined();
    expect(findFlowByTrigger('submit_refund_request')).toBe(refund);
    expect(findNodeByTool(refund!, 'query_order_status')?.id).toBe('lookup_order');
    expect(findNode(refund!, 'confirm_refund')?.confirm).toBe(true);
    // 没注册的工具不该命中任何流程
    expect(findFlowByTrigger('query_product_info')).toBeUndefined();
  });

  it('退款流程的前置链是：查订单 → 查优惠 → 提交退款', () => {
    const flow = findFlowByType('refund_request');
    expect(flow).toBeDefined();
    const order = findNode(flow!, 'lookup_order');
    const coupon = findNode(flow!, 'lookup_coupon');
    const confirm = findNode(flow!, 'confirm_refund');
    expect(order?.requires).toEqual([]);
    expect(coupon?.requires).toEqual(['lookup_order']);
    expect(confirm?.requires).toEqual(['lookup_order', 'lookup_coupon']);
  });

  it('售后工单流程的两个只读前置互不依赖（都能单独先做）', () => {
    const flow = findFlowByType('after_sale_ticket');
    expect(flow).toBeDefined();
    expect(findNode(flow!, 'lookup_order')?.requires).toEqual([]);
    expect(findNode(flow!, 'lookup_shipping')?.requires).toEqual([]);
    expect(findNode(flow!, 'create_ticket')?.requires).toEqual([
      'lookup_order',
      'lookup_shipping',
    ]);
  });
});
