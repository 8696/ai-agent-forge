import { z } from 'zod';
import type { BuiltinTool } from './types';
import { pickSerial, pickNumber } from './mock';

/**
 * 提交退款申请 —— 内置 mock 工具（电商场景 · **敏感操作**）
 *
 * 这个工具存在的意义是演示 **HITL（人工确认）**：
 * 它是「会动数据」的工具，所以 `requires_confirmation` 默认开 ——
 * 模型调用它时**不会直接执行**，先要用户在对话里点确认，
 * 用户点了才真正执行（docs/12-b §B5 的最小实现）。
 *
 * 状态机（missions 表）本轮没建 —— 批准记录暂存在会话的 metadata 里，
 * 下一轮做 B5 时迁进 `missions`。
 */
const REFUND_REASONS = ['商品与描述不符', '收到商品有质量问题', '不想要了', '发错货了', '尺码不合适'] as const;

const schema = z.object({
  order_no: z.string().trim().min(1, '订单号不能为空').max(64),
  /** 退款金额；不填按订单全额退 */
  amount: z.number().positive('退款金额必须大于 0').max(100000, '退款金额超出可退范围').optional(),
  /** 退款事由 */
  reason: z.string().trim().min(1, '请说明退款事由').max(100),
});

export const submitRefundRequest: BuiltinTool = {
  key: 'submit_refund_request',
  name: '提交退款申请',
  description:
    '提交一个订单的退款申请（订单号 + 退款金额 + 事由）。这是一个会真实产生退款单的操作，' +
    '执行前需要用户确认。当用户说「我要退款 / 帮我申请退款 / 退掉 XX 这单」时使用。' +
    '用户要退款一定要调用本工具走申请流程，不要口头答应用户「已退款」。',
  inputSchema: schema,
  sampleArgs: { order_no: 'SO-2026-0001', amount: 199, reason: '商品与描述不符' },
  sensitive: true,
  async execute(ctx, args) {
    const { order_no, amount, reason } = schema.parse(args);
    return {
      refund_no: pickSerial(ctx.tenantId, `refund:${order_no}:${reason}`, 'RF'),
      order_no,
      amount: amount ?? pickNumber(ctx.tenantId, `refund:${order_no}:full`, 39, 2400),
      reason,
      status: 'submitted',
      submitted_at: new Date().toISOString(),
      estimated_arrival_days: pickNumber(ctx.tenantId, `refund:${order_no}:days`, 1, 15),
      note: '这是内置 mock 工具生成的退款单，不会真的进入任何支付或订单系统。',
    };
  },
};
