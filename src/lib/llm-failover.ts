import { logger } from '../logger';

/**
 * LLM 调用的备用模型切换（C4 · 迁移 `030`）
 *
 * ## 语义
 *
 * 主模型**彻底失败**（重试耗尽 / provider 报错 / 连不上）后，
 * 如果租户配了备用模型，就用它**再试一次**。
 *
 * ## ⚠️ 流式与非流式的差别（这是本设计最重要的一条）
 *
 * - **非流式**（`generateText`）：失败就是失败，切备用**没有副作用**。
 *   记忆抽取 / 会话摘要走这条。
 * - **流式**（`streamText`）：**已经吐出去的字收不回来**。
 *   所以只有在「一个 chunk 都还没吐出去」时才能切 ——
 *   切了之后内容不重复，用户看不出发生过切换。
 *
 * 换句话说：**failover 只在「还没产出任何内容」时安全。**
 */

/** 一次 LLM 调用要用的连接配置 */
export interface LlmTarget {
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature?: number | null | undefined;
  maxOutputTokens?: number | null | undefined;
  promptCacheEnabled?: boolean | undefined;
}

/**
 * 带备用模型的调用。
 *
 * @param call 用给定的连接配置跑一次（内部该带重试就带重试）
 */
export async function withModelFallback<T>(params: {
  /** 主模型 */
  primary: LlmTarget;
  /** 备用模型；null = 没配（失败就直接抛） */
  fallback: LlmTarget | null;
  /** 跑一次调用 */
  call: (target: LlmTarget) => Promise<T>;
  /** 切备用时的回调（记日志 / span） */
  onFailover?: ((err: unknown, fallback: LlmTarget) => void) | undefined;
}): Promise<T> {
  try {
    return await params.call(params.primary);
  } catch (err: unknown) {
    const fallback = params.fallback;
    if (fallback === null || fallback === undefined) {
      throw err;
    }
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        primaryModel: params.primary.model,
        fallbackModel: fallback.model,
      },
      '主模型调用失败，切备用模型重试',
    );
    params.onFailover?.(err, fallback);
    return await params.call(fallback);
  }
}

/** 流式 chunk 里带正文的那种（用来判断「有没有吐过内容」） */
interface TextLikeChunk {
  type: string;
  delta?: unknown;
}

/**
 * 流式 failover —— **只在「一个内容 chunk 都还没吐出去」时才切**。
 *
 * ## 为什么有这条限制
 *
 * **已经吐给浏览器的字收不回来。** 切了备用模型重来，用户会看到同一段回答出现两次
 * （前半段来自主模型、后半段来自备用模型），或者更糟 —— 重复的 tool call
 * 会真的执行两遍（提交两次退款单）。
 *
 * 所以规则是：
 *  - 还没吐过任何内容 → 切备用（用户完全看不出发生过切换）
 *  - 已经吐过内容 → **不切**，把错误原样透出去
 *
 * ## AI SDK v7 的错误形态
 *
 * 实测（2026-10-26）：provider 挂掉时 `streamText` **不抛错**，
 * 而是往流里吐一个 `{ type: 'error' }` 的 chunk，然后流正常结束。
 * 所以「主模型失败」在这个层表现为**收到 error chunk**，不是流抛异常。
 *
 * @param onSwitch 切到备用时回调（调用方要在这里换 usage —— 主模型的 usage 是空的）
 */
export function failoverTextStream<T extends TextLikeChunk, U>(params: {
  /** 主模型的流 */
  primary: ReadableStream<T>;
  /** 备用模型的启动器；null = 没配备用 */
  startFallback: (() => { stream: ReadableStream<T>; usage: PromiseLike<U> }) | null;
  /** 切备用时回调（换 usage） */
  onSwitch: (usage: PromiseLike<U>) => void;
  /** 切备用时的回调（记日志） */
  onFailover?: ((err: unknown) => void) | undefined;
}): { stream: ReadableStream<T>; text: Promise<string> } {
  let accumulated = '';
  let settle: ((v: string) => void) | null = null;
  const text = new Promise<string>((resolve) => {
    settle = resolve;
  });

  async function* generate(): AsyncGenerator<T> {
    const reader = params.primary.getReader();
    // 「有没有吐过内容」—— error chunk 本身不算内容
    let contentEmitted = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        if (value.type === 'error') {
          const start = params.startFallback;
          if (!contentEmitted && start !== null) {
            const started = start();
            params.onSwitch(started.usage);
            params.onFailover?.(value);
            const fbReader = started.stream.getReader();
            while (true) {
              const r = await fbReader.read();
              if (r.done) {
                return;
              }
              if (r.value.type === 'text-delta' && typeof r.value.delta === 'string') {
                accumulated += r.value.delta;
              }
              yield r.value;
            }
          }
          // 没备用 / 已经吐过内容 → 把错误原样透出去（前端会显示成流内 error）
          yield value;
          continue;
        }
        contentEmitted = true;
        if (value.type === 'text-delta' && typeof value.delta === 'string') {
          accumulated += value.delta;
        }
        yield value;
      }
    } finally {
      settle?.(accumulated);
    }
  }

  return { stream: ReadableStream.from(generate()), text };
}
