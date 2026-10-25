/**
 * API 错误的统一文案 —— docs/04-d-ui-系统级与公共组件.md §8.4
 *
 * ## 为什么要统一
 *
 * 2026-10-25 之前，每个 api 模块各写了一份 `xxxErrorMessage(err, fallback)`，
 * 逻辑几乎一样（6 份重复代码），而且**都只区分「有没有服务器消息」**：
 * 403 和 500 都会被显示成「加载配置失败（HTTP 403）」这种没有信息量的话。
 *
 * 规格要求：
 *   - 403 → 「没有权限」
 *   - 500 → 「服务异常，已记录」
 *
 * ## 403 的例外
 *
 * 后端有些 403 是**带具体原因的**（比如挂件的「该客服暂未提供服务」、
 * 「不能删除自己」）—— 那些文案要照原样透出，不能一律换成「没有权限」。
 * 后端的通用 403 文案是英文的 'Forbidden'，那个才替换。
 */

/** 后端通用 403 的文案（`ForbiddenError` 的默认值） */
const GENERIC_FORBIDDEN_MESSAGE = 'Forbidden';

export interface ApiErrorInfo {
  /** HTTP 状态码；拿不到就是 undefined（网络错误 / 超时） */
  status: number | undefined;
  /** 该给用户看的话 */
  message: string;
}

export function apiErrorInfo(err: unknown, fallback: string): ApiErrorInfo {
  const e = err as {
    response?: { status?: number; data?: { message?: string } };
    message?: string;
  };
  const status = e.response?.status;
  const serverMessage = e.response?.data?.message;

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
  return { status, message: e.message ?? fallback };
}

/** 只要文案（大多数调用方只需要这个） */
export function apiErrorMessage(err: unknown, fallback: string): string {
  return apiErrorInfo(err, fallback).message;
}
