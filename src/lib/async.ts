/**
 * 小工具：给 promise 加超时。
 *
 * 场景：等 LLM 流结束、等审核模型出结果 —— 这些都是「网络请求」，
 * 不能无限期挂着（流被取消时，AI SDK 的 text promise 可能永远不 resolve）。
 */

/**
 * 等 promise，超时就返回 fallback。
 *
 * ⚠️ 超时分支返回 fallback 而不是抛错 —— 调用方要的是「拿不到就算了」，
 *    不是「整个请求失败」。真要区分这两种情况，自己 catch 原始 promise。
 */
export async function withTimeout<T>(
  promise: PromiseLike<T>,
  timeoutMs: number,
  fallback: T,
): Promise<T> {
  // PromiseLike 没有 .catch —— 先包成真 Promise
  const guarded = Promise.resolve(promise).catch(() => fallback);

  if (timeoutMs <= 0) {
    return guarded;
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      guarded,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
        // 不要因为这个定时器把进程吊住
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
