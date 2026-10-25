import { z } from 'zod';
import type { BuiltinTool } from './types';
import { pickDate, pickOne, pickNumber } from './mock';

/**
 * 查物流轨迹 —— 内置 mock 工具（电商场景）
 *
 * 跟「查订单状态」的区别：那个给的是订单当前状态（一个结论），
 * 这个给的是**一条条轨迹节点**（过程）—— 用户问「快递到哪了 / 什么时候派送的」
 * 时要的是过程。
 */
const CARRIERS = ['顺丰速运', '京东物流', '中通快递', '圆通速递', '韵达快递', 'EMS'] as const;

const STATUSES = ['待揽收', '运输中', '派送中', '已签收'] as const;

const LOCATIONS = ['上海转运中心', '杭州分拨中心', '北京朝阳分部', '广州白云分部', '成都双流分部'] as const;

const NODE_DESCRIPTIONS = [
  '快件已到达【{loc}】，等待转运',
  '快件已从【{loc}】发出，下一站继续派送',
  '快件已到达【{loc}】营业点，等待派送',
  '快递员正在派送，请保持电话畅通',
  '快件已签收，感谢使用',
] as const;

const schema = z.object({
  tracking_no: z.string().trim().min(1, '运单号不能为空').max(64),
});

export const queryShippingTrack: BuiltinTool = {
  key: 'query_shipping_track',
  name: '查物流轨迹',
  description:
    '查询一个运单号的物流轨迹：快递公司、当前状态、预计送达时间，以及逐条的轨迹节点' +
    '（时间 / 地点 / 描述）。当用户问「快递到哪了 / 什么时候到 / 派送了吗 / 物流信息」时使用。' +
    '用户问物流一定要调用本工具查真实轨迹，不要凭印象回答，也不要让用户自己去查快递网站。',
  inputSchema: schema,
  sampleArgs: { tracking_no: 'SF1234567890' },
  sensitive: false,
  async execute(ctx, args) {
    const { tracking_no } = schema.parse(args);
    const carrier = pickOne(ctx.tenantId, `ship:${tracking_no}:carrier`, CARRIERS);
    const status = pickOne(ctx.tenantId, `ship:${tracking_no}:status`, STATUSES);

    // 轨迹节点从早到晚排（天数越小 = 越早）
    const nodeCount = pickNumber(ctx.tenantId, `ship:${tracking_no}:nodes`, 2, 5);
    const traces = [];
    for (let i = 0; i < nodeCount; i++) {
      const loc = pickOne(ctx.tenantId, `ship:${tracking_no}:loc:${i}`, LOCATIONS);
      const desc = pickOne(
        ctx.tenantId,
        `ship:${tracking_no}:desc:${i}`,
        NODE_DESCRIPTIONS,
      ).replace('{loc}', loc);
      traces.push({
        time: `${pickDate(ctx.tenantId, `ship:${tracking_no}:time:${i}`, nodeCount - i, 1)} 12:00`,
        status: desc,
        location: loc,
        description: desc,
      });
    }

    return {
      tracking_no,
      carrier,
      status,
      estimated_delivery: pickDate(ctx.tenantId, `ship:${tracking_no}:eta`, -2, 4),
      traces,
    };
  },
};
