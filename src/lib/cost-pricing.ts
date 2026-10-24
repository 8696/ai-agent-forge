import { config } from '../config';

/**
 * 模型价格表（估算）—— docs/12-d-需求-运维稳定.md §D3
 *
 * ⚠️ **表里的单价是估算值，不是官方报价**。用途只有一个：
 *    给「这条回答大概花了多少钱」一个量级感，方便租户判断用量。
 *    D3 的**预算阈值按 token 计**（不是按钱计），所以这张表不准不影响预算闸门。
 *
 * 想用真实账单价：设环境变量 `COST_PRICE_TABLE`（JSON），格式
 *   {"glm-5.3": {"input": 0.6, "output": 2.2}, "my-model": {"input": 1, "output": 3}}
 * 键是模型 id（支持前缀匹配），值是「美元 / 100 万 token」。
 * 环境变量里的条目**覆盖**内置表。
 *
 * 匹配规则：先找完全相等的 model id，再找最长前缀。都不中 → 单价 0（= 未知，不计费）。
 */

export interface ModelPrice {
  /** 输入单价（USD / 100 万 token） */
  input: number;
  /** 输出单价（USD / 100 万 token） */
  output: number;
  /** 缓存读取单价（USD / 100 万 token）；不填按 input 的 1/10 估 */
  cacheRead?: number;
}

/** 内置估算表（美元 / 100 万 token） */
const BUILTIN_PRICES: Record<string, ModelPrice> = {
  // 智谱 GLM
  'glm-4': { input: 0.6, output: 0.6 },
  'glm-4.5': { input: 0.6, output: 2.2 },
  'glm-4.6': { input: 0.6, output: 2.2 },
  'glm-5': { input: 0.6, output: 2.2 },
  // MiniMax
  'minimax-m': { input: 0.4, output: 1.4 },
  'minimax-m2': { input: 0.4, output: 1.4 },
  // DeepSeek
  'deepseek-chat': { input: 0.27, output: 1.1 },
  'deepseek-reasoner': { input: 0.55, output: 2.19 },
  // 千问
  'qwen-max': { input: 1.6, output: 6.4 },
  'qwen-plus': { input: 0.4, output: 1.2 },
  'qwen-turbo': { input: 0.1, output: 0.4 },
};

/** 环境变量覆盖表（启动时解析一次） */
let envPrices: Record<string, ModelPrice> | null = null;

function loadEnvPrices(): Record<string, ModelPrice> {
  if (envPrices !== null) {
    return envPrices;
  }
  const raw = config.COST.PRICE_TABLE.trim();
  if (raw === '') {
    envPrices = {};
    return envPrices;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, ModelPrice>;
    envPrices = parsed;
  } catch {
    // 配错了不该让服务起不来 —— 价格只是估算，配错就当没配
    envPrices = {};
  }
  return envPrices;
}

/** 找到模型对应的单价；找不到返回 null（= 未知） */
export function findModelPrice(model: string): ModelPrice | null {
  const env = loadEnvPrices();
  const exact = env[model] ?? BUILTIN_PRICES[model];
  if (exact !== undefined) {
    return exact;
  }
  // 前缀匹配：取最长的那个前缀（'glm-4.6' 比 'glm-4' 更具体）
  let best: { key: string; price: ModelPrice } | null = null;
  for (const table of [env, BUILTIN_PRICES]) {
    for (const [key, price] of Object.entries(table)) {
      if (!model.startsWith(key)) {
        continue;
      }
      if (best === null || key.length > best.key.length) {
        best = { key, price };
      }
    }
  }
  return best?.price ?? null;
}

export interface CostUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

/**
 * 估算一次调用的花费（USD）。
 *
 * 缓存命中的 token 按 cacheRead 价算（没有就按 input 的 1/10 估），
 * 缓存写入按 input 价算（写缓存通常不额外收费，但也没省）。
 * 模型不在价格表里 → 返回 0（表示「未知」，不是「免费」）。
 */
export function estimateCostUsd(model: string, usage: CostUsage): number {
  const price = findModelPrice(model);
  if (price === null) {
    return 0;
  }
  const perMillion = (tokens: number, unit: number): number => (tokens / 1_000_000) * unit;

  const input = perMillion(usage.input_tokens, price.input);
  const output = perMillion(usage.output_tokens, price.output);
  const cacheRead = perMillion(
    usage.cache_read_tokens,
    price.cacheRead ?? price.input / 10,
  );
  const cacheWrite = perMillion(usage.cache_write_tokens, price.input);

  const total = input + output + cacheRead + cacheWrite;
  // 保留 6 位小数（DECIMAL(10,6)）
  return Number(total.toFixed(6));
}
