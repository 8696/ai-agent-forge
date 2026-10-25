import type { ChatUIMessage } from '@shared/types/chat';

/**
 * 公开挂件的前端 API 客户端 —— E1
 *
 * 对应后端 src/gateway/public/widget-routes.ts
 *
 * ⚠️ 这里**不用 axios**：挂件在别人家的页面上跑，baseURL / 拦截器那套没必要，
 *    直接 fetch 更省事（也不用带 Authorization —— 挂件是免登录的）。
 *
 * ⚠️ 匿名会话的凭证存在 localStorage 里，key = `widget_token:<租户 code>`：
 *    这样同一个浏览器打开同一个租户的挂件，能接着上次的对话聊（E1 验收：
 *    「关闭浏览器 → 再打开 → 历史还在」）。换浏览器就是新的一段对话。
 */

export interface WidgetTenantInfo {
  tenant_code: string;
  tenant_name: string;
}

export interface WidgetSession {
  session_id: string;
  token: string;
  tenant_name: string;
  title: string | null;
  messages: ChatUIMessage[];
}

/** localStorage 里存匿名会话 token 的 key */
export function widgetTokenKey(tenantCode: string): string {
  return `widget_token:${tenantCode}`;
}

export function readWidgetToken(tenantCode: string): string | null {
  try {
    return localStorage.getItem(widgetTokenKey(tenantCode));
  } catch {
    // 隐私模式下 localStorage 可能直接抛异常（Safari 无痕 / 关了存储权限）
    return null;
  }
}

export function writeWidgetToken(tenantCode: string, token: string): void {
  try {
    localStorage.setItem(widgetTokenKey(tenantCode), token);
  } catch {
    // 存不下就算了 —— 只是这次会话没法「关掉浏览器再打开接着聊」
  }
}

export function clearWidgetToken(tenantCode: string): void {
  try {
    localStorage.removeItem(widgetTokenKey(tenantCode));
  } catch {
    // 同上
  }
}

/** 后端错误体：{ code, message, details } */
interface ApiErrorBody {
  code?: string;
  message?: string;
}

/** 从 fetch 失败里取出后端给的中文文案 */
export function widgetErrorMessage(err: unknown, fallback: string): string {
  const e = err as { status?: number; body?: ApiErrorBody; message?: string };
  if (e.body?.message !== undefined && e.body.message !== '') {
    return e.body.message;
  }
  if (e.status !== undefined) {
    return `${fallback}（HTTP ${e.status}）`;
  }
  return e.message ?? fallback;
}

/** 统一的 fetch 封装：非 2xx 抛错，错误对象上带 status + 后端 message */
async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    let body: ApiErrorBody | undefined;
    try {
      body = JSON.parse(text) as ApiErrorBody;
    } catch {
      body = undefined;
    }
    throw Object.assign(new Error(body?.message ?? `HTTP ${res.status}`), {
      status: res.status,
      body,
    });
  }
  if (text === '') {
    return {} as T;
  }
  return JSON.parse(text) as T;
}

/** 租户信息（页头显示公司名用；不建会话） */
export async function fetchWidgetInfo(tenantCode: string): Promise<WidgetTenantInfo> {
  return request<WidgetTenantInfo>(
    `/api/v1/public/widget/${encodeURIComponent(tenantCode)}/info`,
  );
}

/** 新建匿名会话 → 返回会话 id + 匿名 token */
export async function createWidgetSession(
  tenantCode: string,
): Promise<{ session_id: string; token: string; tenant_name: string }> {
  return request<{ session_id: string; token: string; tenant_name: string }>(
    `/api/v1/public/widget/${encodeURIComponent(tenantCode)}/sessions`,
    { method: 'POST', body: '{}' },
  );
}

/**
 * 凭 token 恢复会话 + 历史消息。
 *
 * token 失效（后端重启换了密钥 / 会话被删）时后端返 404，
 * 前端据此清掉本地 token，重新开一段对话。
 */
export async function resumeWidgetSession(
  tenantCode: string,
  token: string,
): Promise<WidgetSession> {
  return request<WidgetSession>(
    `/api/v1/public/widget/${encodeURIComponent(tenantCode)}/session`,
    { headers: { 'x-widget-token': token } },
  );
}

/**
 * 确认一次敏感工具调用（B3 HITL）。
 *
 * 挂件是匿名会话 —— 但会话本身是 token 认领来的，所以照样能确认。
 * 之前这里是个死路：AI 说「请确认」，用户点不了任何按钮。
 */
export async function approveWidgetToolCall(
  tenantCode: string,
  token: string,
  toolName: string,
  args: unknown,
): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(
    `/api/v1/public/widget/${encodeURIComponent(tenantCode)}/tool-approvals`,
    {
      method: 'POST',
      headers: { 'x-widget-token': token },
      body: JSON.stringify({ tool_name: toolName, args }),
    },
  );
}

/** 取消一次敏感工具调用（用户反悔） */
export async function rejectWidgetToolCall(
  tenantCode: string,
  token: string,
  toolName: string,
  args: unknown,
): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(
    `/api/v1/public/widget/${encodeURIComponent(tenantCode)}/tool-approvals/reject`,
    {
      method: 'POST',
      headers: { 'x-widget-token': token },
      body: JSON.stringify({ tool_name: toolName, args }),
    },
  );
}
