import { z } from 'zod';
import type { BuiltinTool } from './types';
import { pickDate, pickNumber, pickOne } from './mock';

/**
 * 修改收货地址 —— 内置 mock 工具（电商场景 · **敏感操作**）
 *
 * 跟「提交退款申请」一样是**会动数据**的工具，所以 `requires_confirmation` 默认开。
 * 它是流程 `modify_address` 的触发节点（见 docs/12-b-需求-ai对话能力.md §B5.1）。
 *
 * ## 为什么需要它
 *
 * 流程 `modify_address` 要演示的是「**查订单 → 确认 → 改地址**」这条链：
 * 模型必须先查订单（确认订单存在且未发货）才能走到这一步 ——
 * 这正是「前置节点没满足时闸门要拦住模型」的用例。
 *
 * ⚠️ 跟退款流程一样，本工具**不会真的进任何订单系统**，返回的是 mock 结果。
 */
const CITIES = ['上海市', '北京市', '杭州市', '广州市', '成都市', '南京市'] as const;

const DISTRICTS = ['浦东新区', '朝阳区', '西湖区', '天河区', '武侯区', '鼓楼区'] as const;

const schema = z.object({
  /** 订单号 */
  order_no: z.string().trim().min(1, '订单号不能为空').max(64),
  /** 新收货地址（详细到门牌） */
  address: z.string().trim().min(4, '收货地址太短了，请写详细一些').max(200),
  /** 收件人（不传就用订单上的） */
  receiver: z.string().trim().max(32).optional(),
});

export const updateShippingAddress: BuiltinTool = {
  key: 'update_shipping_address',
  name: '修改收货地址',
  description:
    '修改一个订单的收货地址（订单号 + 新地址 [+ 收件人]）。' +
    '这是一个会真实修改订单数据的操作，执行前需要用户确认。' +
    '当用户说「改地址 / 换个收货地址 / 我的地址填错了」时使用。' +
    '调用本工具之前必须先查订单状态（确认订单存在且还没发货），' +
    '一定要调用本工具走修改流程，不要口头答应用户「已改好」。',
  inputSchema: schema,
  sampleArgs: { order_no: 'SO-2026-0001', address: '浦东新区世纪大道 100 号 3 楼' },
  sensitive: true,
  async execute(ctx, args) {
    const { order_no, address, receiver } = schema.parse(args);
    return {
      order_no,
      previous_address: `（原地址）${pickOne(ctx.tenantId, `addr:${order_no}:city`, CITIES)}${pickOne(
        ctx.tenantId,
        `addr:${order_no}:district`,
        DISTRICTS,
      )}·原地址详址`,
      new_address: address,
      receiver: receiver ?? '原收件人',
      updated_at: new Date().toISOString(),
      // 改地址之后订单要重新走配送，mock 里给个预计到达
      expected_redelivery: pickDate(ctx.tenantId, `addr:${order_no}:redeliver`, -3, 5),
      fee: pickNumber(ctx.tenantId, `addr:${order_no}:fee`, 0, 12),
      note: '这是内置 mock 工具生成的修改结果，不会真的进入任何订单系统。',
    };
  },
};
