import { z } from 'zod';
import type { BuiltinTool } from './types';
import { pickNumber, pickOne, pickSerial } from './mock';

/**
 * 创建售后工单 —— 内置 mock 工具（电商场景 · **敏感操作**）
 *
 * 流程 `after_sale_ticket` 的触发节点（见 docs/12-b-需求-ai对话能力.md §B5.1）。
 *
 * ## 为什么需要它
 *
 * 流程 `after_sale_ticket` 要演示的是「**两个互不依赖的只读前置 + 一步副作用**」：
 * 查订单 + 查物流两件事都得做完，才允许建工单。
 * 缺任何一件，闸门都会拦下来并告诉模型「先查什么」。
 *
 * ⚠️ 跟退款流程一样，本工具**不会真的进任何工单系统**，返回的是 mock 结果。
 */
const ISSUE_TYPES = ['商品破损', '与描述不符', '少发漏发', '质量问题', '配送异常'] as const;

const PRIORITIES = ['低', '中', '高'] as const;

const schema = z.object({
  /** 订单号 */
  order_no: z.string().trim().min(1, '订单号不能为空').max(64),
  /** 问题类型 */
  issue_type: z.enum(ISSUE_TYPES),
  /** 问题描述 */
  description: z.string().trim().min(2, '请简要描述问题').max(500),
});

export const createAfterSaleTicket: BuiltinTool = {
  key: 'create_after_sale_ticket',
  name: '创建售后工单',
  description:
    '为��个订单创建售后工单（订单号 + 问题类型 + 问题描述）。' +
    '这是一个会真实产生一条工单的操作，执行前需要用户确认。' +
    '当用户说「我要投诉 / 申请售后 / 商品有问题要反馈 / 建个工单」时使用。' +
    '调用本工具之前必须先查订单状态和物流轨迹，' +
    '一定要调用本工具走工单流程，不要口头答应用户「已提交」。',
  inputSchema: schema,
  sampleArgs: { order_no: 'SO-2026-0001', issue_type: '商品破损', description: '收到的杯子有裂缝' },
  sensitive: true,
  async execute(ctx, args) {
    const { order_no, issue_type, description } = schema.parse(args);
    return {
      ticket_no: pickSerial(ctx.tenantId, `ticket:${order_no}:${issue_type}`, 'TK'),
      order_no,
      issue_type,
      description,
      priority: pickOne(ctx.tenantId, `ticket:${order_no}:priority`, PRIORITIES),
      status: 'submitted',
      created_at: new Date().toISOString(),
      // 工单要等人处理，mock 里给个响应时长
      response_hours: pickNumber(ctx.tenantId, `ticket:${order_no}:hours`, 2, 48),
      note: '这是内置 mock 工具生成的工单，不会真的进入任何工单系统。',
    };
  },
};
