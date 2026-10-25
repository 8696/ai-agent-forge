/**
 * 带抖动的重试 —— docs/07-e-模块-评测观测可靠性.md 模块 19「重试」
 * （对应 12-d §D5「重试：指数退避 + 抖动」）
 *
 * ## 为什么 AI SDK 自带的重试不够
 *
 * AI SDK v7 的 `retryWithExponentialBackoffRespectingRetryHeaders`：
 *   - ✅ 指数退避（2s → 4s，factor 2）
 *   - ✅ 尊重 `Retry-After` 响应头
 *   - ❌ **没有抖动** —— 默认的 `getDelayInMs` 直接返回 `exponentialBackoffDelay` 原值
 *
 * 没有抖动的后果很具体：**上游挂着的时候，所有并发请求会在同一毫秒一起重试**，
 * 把刚要恢复的上游再打死一次（惊群）。后端一恢复就又被压垮，
 * 于是「过一阵自己好了」这件事永远不发生。
 *
 * ## 这层做什么
 *
 * **全抖动（full jitter）**：`delay = random(0, min(cap, base * factor^attempt))`。
 * 不是在指数值上加一个随机偏移，而是直接在 [0, 上限] 里随机 ——
 * 这样重试请求在时间轴上是散开的，而不是挤在某个时间点附近。
 *
 * ## 用在哪
 *
 * 包住**非流式**的 LLM 调用（摘要 / 记忆抽取 / 审核 / 评测 / 查询改写）。
 * 流式对话（`streamText`）不包 —— 中途失败时已经吐出去一半了，
 * 重来一次会把内容吐两遍；那种场景交给 SDK 自己重试**首次请求**。
 */

export interface RetryOptions {
  /** 额外重试次数（默认 2 —— 加上首次一共 3 次） */
  maxRetries?: number;
  /** 首次退避基数（毫秒，默认 1000） */
  initialDelayMs?: number;
  /** 退避上限（毫秒，默认 8000） */
  maxDelayMs?: number;
  /** 退避因子（默认 2） */
  backoffFactor?: number;
  /** 这个错误值不值得重试（默认按 HTTP 状态码 / 网络错误判断） */
  isRetryable?: (err: unknown) => boolean;
  /** 每次重试前的回调（记日志用） */
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
  /** 取消信号（用户断开时别再重试） */
  signal?: AbortSignal | undefined;
}

/** 从错误对象里掏 HTTP 状态码（AI SDK 的 APICallError 有 statusCode） */
function statusOf(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) {
    return null;
  }
  const e = err as { statusCode?: unknown; status?: unknown; response?: { status?: unknown } };
  for (const v of [e.statusCode, e.status, e.response?.status]) {
    if (typeof v === 'number') {
      return v;
    }
  }
  return null;
}

/**
 * 默认的「值不值得重试」判断：
 *  - 429（限流）→ 重试
 *  - 5xx（上游挂了）→ 重试
 *  - 网络层错误（fetch failed / ECONNRESET / ETIMEDOUT）→ 重试
 *  - 4xx（请求本身不对）→ **不重试**（重试多少次都一样）
 */
export function defaultIsRetryable(err: unknown): boolean {
  const status = statusOf(err);
  if (status !== null) {
    return status === 429 || (status >= 500 && status <= 599);
  }
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const e = err as { name?: unknown; message?: unknown; cause?: unknown };
  const name = typeof e.name === 'string' ? e.name : '';
  const message = typeof e.message === 'string' ? e.message : '';
  if (name === 'AbortError' || message.includes('abort')) {
    return false;
  }
  if (name === 'TypeError' && /fetch failed|network|ECONN/i.test(message)) {
    return true;
  }
  if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up/i.test(message)) {
    return true;
  }
  const cause = e.cause as { code?: unknown; message?: unknown } | undefined;
  if (cause !== undefined && cause !== null) {
    const code = typeof cause.code === 'string' ? cause.code : '';
    if (['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN'].includes(code)) {
      return true;
    }
  }
  return false;
}

/**
 * 从错误里读上游给的「等多久再试」（Retry-After / retry-after-ms）。
 *
 * 上游说「30 秒后再来」就该等 30 秒 —— 提前重试只是浪费一次配额。
 * 读不到就返回 null（走抖动退避）。
 */
export function retryAfterMs(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) {
    return null;
  }
  const e = err as { responseHeaders?: Record<string, string | undefined> };
  const headers = e.responseHeaders;
  if (headers === undefined || headers === null) {
    return null;
  }
  const rawMs = headers['retry-after-ms'];
  if (typeof rawMs === 'string' && rawMs !== '') {
    const n = Number(rawMs);
    if (Number.isFinite(n) && n >= 0) {
      return Math.min(n, 60_000);
    }
  }
  const raw = headers['retry-after'];
  if (typeof raw === 'string' && raw !== '') {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, 60_000);
    }
  }
  return null;
}

/** 全抖动：random(0, min(cap, base * factor^attempt)) */
export function jitteredDelay(attempt: number, opts: Required<Pick<RetryOptions, 'initialDelayMs' | 'maxDelayMs' | 'backoffFactor'>>): number {
  const ceiling = Math.min(opts.maxDelayMs, opts.initialDelayMs * opts.backoffFactor ** attempt);
  return Math.floor(Math.random() * ceiling);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error('已取消'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('已取消'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 带指数退避 + 抖动的重试。
 *
 * 失败且「值得重试」时重试；重试次数用完或错误不值得重试 → 抛最后一次的错。
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxRetries = opts.maxRetries ?? 2;
  const delayOpts = {
    initialDelayMs: opts.initialDelayMs ?? 1000,
    maxDelayMs: opts.maxDelayMs ?? 8000,
    backoffFactor: opts.backoffFactor ?? 2,
  };
  const isRetryable = opts.isRetryable ?? defaultIsRetryable;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastErr = err;
      if (attempt === maxRetries || !isRetryable(err)) {
        throw err;
      }
      // 上游明确说了「等多久」就照它说的等；没说就用抖动退避
      const delayMs = retryAfterMs(err) ?? jitteredDelay(attempt, delayOpts);
      opts.onRetry?.(attempt + 1, delayMs, err);
      await sleep(delayMs, opts.signal);
    }
  }
  throw lastErr;
}
