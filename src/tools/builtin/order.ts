import { z } from 'zod';
import type { BuiltinTool } from './types';
import { pickDate, pickOne, pickSerial, pickNumber } from './mock';

/**
 * 查订单状态 —— 内置 mock 工具（电商场景）
 *
 * 演示用：让 AI 能拿到「知识库里没有」的真实数据，
 * 而不是把订单号编出来（这正是 B3 要解决的核心问题）。
 *
 * 数据是按 (租户, 单号) 确定性生成的 mock —— 不是真的订单系统。
 */
const ORDER_STATUSES = [
  '待付款',
  '待发货',
  '已发货',
  '运输中',
  '已签收',
  '已取消',
  '退款中',
] as const;

const CARRIERS = ['顺丰速运', '京东物流', '中通快递', '圆通速递', '韵达快递', 'EMS'] as const;

const PRODUCT_NAMES = [
  '无线降噪耳机 Pro',
  '智能手表 运动款',
  '便携榨汁杯 500ml',
  '全棉四件套 1.8m 床',
  '氨基酸洗面奶 120g',
  '有机冷榨橄榄油 1L',
  '儿童益智积木 套装',
  '桌面收纳盒 三层',
] as const;

const PAY_METHODS = ['微信支付', '支付宝', '银行卡', '余额宝'] as const;

/** 已经发货的订单状态 —— 只有这些状态才有承运商和运单号 */
const SHIPPED_STATUSES: readonly string[] = ['已发货', '运输中', '已签收'];

const schema = z.object({
  order_no: z.string().trim().min(1, '订单号不能为空').max(64),
});

export const queryOrderStatus: BuiltinTool = {
  key: 'query_order_status',
  name: '查订单状态',
  description:
    '查询一个订单的当前状态、商品、金额、快递公司、运单号和预计送达时间。' +
    '当用户问「我的订单 XX 到哪了 / 发货了吗 / 什么时候到 / 买了什么」时使用。' +
    '用户问到订单一定要调用本工具查真实数据，不要凭印象回答，也不要让用户自己去订单中心找。',
  inputSchema: schema,
  sampleArgs: { order_no: 'SO-2026-0001' },
  sensitive: false,
  async execute(ctx, args) {
    const { order_no } = schema.parse(args);
    const status = pickOne(ctx.tenantId, `order:${order_no}:status`, ORDER_STATUSES);
    const productName = pickOne(ctx.tenantId, `order:${order_no}:product`, PRODUCT_NAMES);
    const quantity = pickNumber(ctx.tenantId, `order:${order_no}:qty`, 1, 4);
    const totalAmount = pickNumber(ctx.tenantId, `order:${order_no}:amount`, 39, 2400);

    // ⚠️ **没发货的订单没有运单号** —— 待付款 / 待发货 / 已取消 / 退款中，
    //    承运商和运单号都应该是空的。之前一律给一个运单号，
    //    模型看到「待发货 + 运单号 SFxxx」会犯迷糊（甚至自己把运单号吞掉不说）。
    const shipped = SHIPPED_STATUSES.includes(status);

    return {
      order_no,
      status,
      product_name: productName,
      quantity,
      total_amount: totalAmount,
      currency: 'CNY',
      pay_method: pickOne(ctx.tenantId, `order:${order_no}:pay`, PAY_METHODS),
      carrier: shipped ? pickOne(ctx.tenantId, `order:${order_no}:carrier`, CARRIERS) : null,
      tracking_no: shipped ? pickSerial(ctx.tenantId, `order:${order_no}:tracking`, 'SF') : null,
      placed_at: pickDate(ctx.tenantId, `order:${order_no}:placed`, 20, 3),
      estimated_delivery: shipped ? pickDate(ctx.tenantId, `order:${order_no}:eta`, -3, 6) : null,
    };
  },
};
