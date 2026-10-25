import { z } from 'zod';
import type { BuiltinTool } from './types';
import { pickDate, pickNumber, pickOne } from './mock';

/**
 * 查可用优惠 —— 内置 mock 工具（电商场景）
 *
 * 优惠券在电商客服里是高频问题（「我有什么券 / 满多少减多少 / 券过期了吗」）。
 * 券的状态是「按 (租户, 用户) 确定性生成」的 —— 同一个用户每次查出来一样。
 */
const COUPON_NAMES = [
  '满 199 减 30',
  '满 399 减 80',
  '满 99 减 10',
  '新人 20 元无门槛券',
  '家电专享 95 折',
  '生鲜品类满 59 减 15',
] as const;

const COUPON_TYPES = ['满减', '折扣', '无门槛'] as const;

const COUPON_STATUSES = ['可用', '已用', '已过期'] as const;

const schema = z.object({
  /** 用户 id；不传就按「当前用户」处理 */
  user_id: z.string().trim().max(64).optional(),
});

export const queryCouponInfo: BuiltinTool = {
  key: 'query_coupon_info',
  name: '查可用优惠',
  description:
    '查询一个用户账户上的优惠券：券名、类型（满减 / 折扣 / 无门槛）、使用门槛、优惠额度、有效期和状态。' +
    '当用户问「我有什么优惠券 / 满多少减多少 / 我的券过期了吗 / 怎么用券」时使用。' +
    '用户问券一定要调用本工具查账户上真实的券，不要凭印象回答，也不要让用户自己去「我的优惠券」页面看。',
  inputSchema: schema,
  sampleArgs: { user_id: 'U10086' },
  sensitive: false,
  async execute(ctx, args) {
    const { user_id } = schema.parse(args);
    const uid = (user_id ?? '').trim() || 'current';
    const count = pickNumber(ctx.tenantId, `coupon:${uid}:count`, 1, 4);

    const coupons = [];
    for (let i = 0; i < count; i++) {
      const type = pickOne(ctx.tenantId, `coupon:${uid}:type:${i}`, COUPON_TYPES);
      const threshold =
        type === '无门槛'
          ? 0
          : pickNumber(ctx.tenantId, `coupon:${uid}:threshold:${i}`, 50, 500);
      const discount =
        type === '折扣'
          ? pickNumber(ctx.tenantId, `coupon:${uid}:discount:${i}`, 80, 95) / 10
          : pickNumber(ctx.tenantId, `coupon:${uid}:cut:${i}`, 5, 100);
      coupons.push({
        name: pickOne(ctx.tenantId, `coupon:${uid}:name:${i}`, COUPON_NAMES),
        type,
        threshold,
        discount,
        expire_at: pickDate(ctx.tenantId, `coupon:${uid}:expire:${i}`, 30, 1),
        status: pickOne(ctx.tenantId, `coupon:${uid}:status:${i}`, COUPON_STATUSES),
      });
    }

    return {
      user_id: uid,
      usable_count: coupons.filter((c) => c.status === '可用').length,
      coupons,
    };
  },
};
