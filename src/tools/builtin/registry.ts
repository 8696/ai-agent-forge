import type { BuiltinTool } from './types';
import { queryOrderStatus } from './order';
import { queryProductInfo } from './product';
import { queryShippingTrack } from './shipping';
import { queryCouponInfo } from './coupon';
import { listKnowledgeDocuments } from './knowledge';
import { submitRefundRequest } from './refund';

/**
 * 内置工具注册表 —— 代码侧的全部可用实现
 *
 * 租户在 `/admin/tools` 注册时，`config.builtin` 里存的就是这里的 key。
 * **加一个内置工具 = 在这里加一个条目**（不用改表结构、不用发版改注册流程），
 * 租户那边刷新一下「注册工具」的下拉框就能选到。
 *
 * 本轮内置的 6 个工具是**电商客服场景**，覆盖三种典型形态：
 *  - mock 数据（订单 / 商品 / 物流 / 优惠券）—— 演示「AI 能拿到知识库之外的实时数据」
 *  - 真实数据（知识库文档清单）—— 演示「工具能触到真实库」
 *  - 敏感操作（提交退款申请）—— 演示 HITL 人工确认
 */
export const BUILTIN_TOOLS: Record<string, BuiltinTool> = {
  [queryOrderStatus.key]: queryOrderStatus,
  [queryProductInfo.key]: queryProductInfo,
  [queryShippingTrack.key]: queryShippingTrack,
  [queryCouponInfo.key]: queryCouponInfo,
  [listKnowledgeDocuments.key]: listKnowledgeDocuments,
  [submitRefundRequest.key]: submitRefundRequest,
};

/** 按 key 取实现；取不到说明注册了一条指向已下架实现的记录 */
export function getBuiltinTool(key: string): BuiltinTool | undefined {
  return Object.prototype.hasOwnProperty.call(BUILTIN_TOOLS, key) ? BUILTIN_TOOLS[key] : undefined;
}

/** 全部内置实现（后台「注册工具」下拉框用） */
export function listBuiltinTools(): BuiltinTool[] {
  return Object.values(BUILTIN_TOOLS);
}

export type { BuiltinTool, BuiltinToolContext } from './types';
