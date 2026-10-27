/**
 * API 错误的统一文案 —— docs/04-d-ui-系统级与公共组件.md §8.4
 *
 * ## 为什么要统一
 *
 * 2026-10-25 之前，每个 api 模块各写了一份 `xxxErrorMessage(err, fallback)`，
 * 逻辑几乎一样（6 份重复代码），而且**都只区分「有没有服务器消息」**：
 * 403 和 500 都会被显示成「加载配置失败（HTTP 403）」这种没有信息量的话。
 *
 * 规格要求（04-d §8.4）：
 *   - 网络错误 → toast「网络异常，请稍后重试」
 *   - 403 → toast「没有权限」
 *   - 500 → toast「服务异常，已记录」
 *
 * ## ⚠️ 这里是**唯一真源**
 *
 * 2026-10-27 之前只有 5 个模块用了这里的实现，
 * 另外 4 个模块（`adminKnowledge` / `adminMemory` / `customerChat` / `customerMemory`）
 * 各自抄了一份旧版 `errorMessage()` —— 用户看到的是英文 `'Forbidden'`
 * 和 `'服务器内部错误'`。那 4 个模块归别的 agent 管，**别在这里重复实现**：
 * 直接 `import { apiErrorMessage } from './apiError'`。
 *
 * ## 403 的例外
 *
 * 后端有些 403 是**带具体原因的**（比如挂件的「该客服暂未提供服务」、
 * 「不能删除自己」）—— 那些文案要照原样透出，不能一律换成「没有权限」。
 * 后端的通用 403 文案是英文的 'Forbidden'，那个才替换。
 */

/** 后端通用 403 的文案（`ForbiddenError` 的默认值） */
const GENERIC_FORBIDDEN_MESSAGE = 'Forbidden';

/** 规格 §8.4 的网络错误文案 */
export const NETWORK_ERROR_MESSAGE = '网络异常，请稍后重试';

/** 超时单独说一句（比「网络异常」更准，用户知道是慢不是断） */
export const TIMEOUT_ERROR_MESSAGE = '网络超时，请稍后重试';

/**
 * 后端「旧密码不对」的文案 —— `src/services/change-password.ts:43`
 *
 * ⚠️ **它也是 401**，但跟「token 过期」（`src/lib/jwt.ts:51` 的
 *    「无效或过期的 token」）完全是两回事：
 *    前者不能清 token（会把正在改密的用户白踢回登录页），
 *    后者必须清 token + 跳登录（否则用户卡死在改密页上出不来）。
 *
 *    两者靠**响应体的 message 区分** —— 401 本身区分不出来。
 */
export const WRONG_OLD_PASSWORD_MESSAGE = '原密码不正确';

export interface ApiErrorInfo {
  /** HTTP 状态码；拿不到就是 undefined（网络错误 / 超时） */
  status: number | undefined;
  /** 该给用户看的话 */
  message: string;
}

/** axios 错误对象里我们关心的那几个字段 */
interface AxiosLikeError {
  response?: { status?: number; data?: { message?: string } };
  message?: string;
  code?: string;
}

/**
 * 后端返回的原始文案 —— 拿不到就是 undefined。
 *
 * 「旧密码不对」和「token 过期」都是 401，只能靠这个字段区分。
 */
export function apiServerMessage(err: unknown): string | undefined {
  const e = err as AxiosLikeError;
  const msg = e.response?.data?.message;
  return typeof msg === 'string' && msg !== '' ? msg : undefined;
}

/**
 * 这个 401 是不是「旧密码不对」（而不是 token 过期）？
 *
 * 用于 401 豁免：改密码时旧密码不对也是 401，清 token 会把
 * 正在改密的用户白踢回登录页（docs/04-b §4.x 的约束）。
 */
export function isWrongOldPasswordError(err: unknown): boolean {
  const e = err as AxiosLikeError;
  return e.response?.status === 401 && apiServerMessage(err) === WRONG_OLD_PASSWORD_MESSAGE;
}

/**
 * 没有 HTTP 响应时的文案 —— 网络层失败（断网 / 超时 / 请求被取消 / CORS）。
 *
 * ⚠️ **axios 的英文文案不能直接透出去** —— 用户看到「Network Error」，
 *    规格要求的是「网络异常，请稍后重试」（04-d §8.4）。
 *    但**有信息量的自定义文案要保留**（比如业务代码自己 throw 的 Error）。
 */
function networkErrorMessage(e: AxiosLikeError): string {
  const raw = typeof e.message === 'string' ? e.message.trim() : '';

  // axios 的默认文案 —— 一律换成规格文案
  if (raw === 'Network Error' || e.code === 'ERR_NETWORK') {
    return NETWORK_ERROR_MESSAGE;
  }
  if (
    raw === 'timeout' ||
    e.code === 'ECONNABORTED' ||
    e.code === 'ETIMEDOUT' ||
    /^timeout of \d+\s?ms exceeded$/i.test(raw)
  ) {
    return TIMEOUT_ERROR_MESSAGE;
  }
  if (raw === 'canceled' || e.code === 'ERR_CANCELED') {
    return '请求已取消';
  }
  if (raw === '') {
    return NETWORK_ERROR_MESSAGE;
  }
  // 其它 = 业务自己抛的文案（有信息量）→ 照原样透出
  return raw;
}

export function apiErrorInfo(err: unknown, fallback: string): ApiErrorInfo {
  const e = (err ?? {}) as AxiosLikeError;
  const status = e.response?.status;
  const serverMessage = apiServerMessage(err);

  if (status === 403) {
    // 带具体原因的 403 照原样透出；通用的那个才换成「没有权限」
    const message =
      serverMessage !== undefined && serverMessage !== GENERIC_FORBIDDEN_MESSAGE
        ? serverMessage
        : '没有权限';
    return { status, message };
  }
  if (status === 500) {
    return { status, message: '服务异常，已记录' };
  }
  if (status !== undefined && serverMessage !== undefined) {
    return { status, message: serverMessage };
  }
  if (status !== undefined) {
    return { status, message: `${fallback}（HTTP ${status}）` };
  }
  // 没有响应 = 网络层失败
  return { status, message: networkErrorMessage(e) };
}

/** 只要文案（大多数调用方只需要这个） */
export function apiErrorMessage(err: unknown, fallback: string): string {
  return apiErrorInfo(err, fallback).message;
}
