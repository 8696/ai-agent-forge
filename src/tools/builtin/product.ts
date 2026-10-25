import { z } from 'zod';
import type { BuiltinTool } from './types';
import { pickNumber, pickOne, pickSerial } from './mock';

/**
 * 查商品信息 —— 内置 mock 工具（电商场景）
 *
 * 商品目录不在本项目里（那是 ERP / 商品中台的活），所以这里给的是 mock 数据：
 * 类目、品牌、价格、库存、评分。够演示「AI 能报出实时价格和库存」。
 */
const CATEGORIES = [
  '手机数码',
  '家用电器',
  '服饰鞋包',
  '美妆护肤',
  '食品生鲜',
  '母婴玩具',
  '家居日用',
] as const;

const BRANDS = ['星辰', '云栖', '拓野', '简行', '木白', '海蓝'] as const;

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

const schema = z.object({
  /** 商品 id（SKU）；和 keyword 至少给一个 */
  product_id: z.string().trim().max(64).optional(),
  /** 商品关键词 / 名称片段；和 product_id 至少给一个 */
  keyword: z.string().trim().max(64).optional(),
});

export const queryProductInfo: BuiltinTool = {
  key: 'query_product_info',
  name: '查商品信息',
  description:
    '查询一个商品的信息：名称、类目、品牌、现价、原价、库存、评分、已售数量。' +
    '当用户问「这个多少钱 / 还有货吗 / 这个东西怎么样 / 顺便推荐一款同类商品」时使用。' +
    '（商品 id 和关键词至少给一个）' +
    '用户问到价格或库存一定要调用本工具查实时数据，不要凭印象报价，也不要让用户自己去商品页看。',
  inputSchema: schema,
  sampleArgs: { keyword: '耳机' },
  sensitive: false,
  async execute(ctx, args) {
    const { product_id, keyword } = schema.parse(args);
    const id = (product_id ?? '').trim();
    const word = (keyword ?? '').trim();
    if (id === '' && word === '') {
      throw new Error('商品 id 和关键词至少要给我一个');
    }

    // 用 id 或关键词做确定性种子 —— 同一个商品每次查出来一样
    const seed = id !== '' ? `product:${id}` : `product_kw:${word}`;
    const price = pickNumber(ctx.tenantId, `${seed}:price`, 29, 1999);
    const originalPrice = price + pickNumber(ctx.tenantId, `${seed}:orig`, 10, 400);

    return {
      product_id: id !== '' ? id : pickSerial(ctx.tenantId, seed, 'SKU'),
      name: pickOne(ctx.tenantId, `${seed}:name`, PRODUCT_NAMES),
      category: pickOne(ctx.tenantId, `${seed}:cat`, CATEGORIES),
      brand: pickOne(ctx.tenantId, `${seed}:brand`, BRANDS),
      price,
      original_price: originalPrice,
      stock: pickNumber(ctx.tenantId, `${seed}:stock`, 0, 500),
      rating: (pickNumber(ctx.tenantId, `${seed}:rating`, 35, 50) / 10).toFixed(1),
      sold_count: pickNumber(ctx.tenantId, `${seed}:sold`, 0, 20000),
      currency: 'CNY',
    };
  },
};
