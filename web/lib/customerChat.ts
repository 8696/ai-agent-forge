import { customerApi } from './customerApi';
import { getToken } from './apiFactory';
import type { ChatUIMessage, SessionListItem } from '@shared/types/chat';

/**
 * customer 对话 API 客户端 —— 对应 src/gateway/customer/chat-routes.ts
 * UI 详见 docs/04-b-ui-登录与聊天挂件.md §4
 *
 * ⚠️ 这一层**只管 REST**（会话 CRUD / 历史 / 反馈）。
 * 流式发消息走 `@ai-sdk/react` 的 useChat + DefaultChatTransport，不走这里 ——
 * 那条路用的是 fetch，不是 axios，而且要保持长连接。
 */

export interface SessionPagination {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
}

export interface CreateSessionResponse {
  id: string;
  title: string | null;
  channel: string;
  status: string;
  started_at: string;
}

export type { SessionListItem, ChatUIMessage };

export async function fetchSessions(page = 1, pageSize = 50): Promise<{
  sessions: SessionListItem[];
  pagination: SessionPagination;
}> {
  const { data } = await customerApi.get<{
    sessions: SessionListItem[];
    pagination: SessionPagination;
  }>('/sessions', { params: { page, page_size: pageSize } });
  return data;
}

export async function createSession(title?: string): Promise<CreateSessionResponse> {
  const { data } = await customerApi.post<CreateSessionResponse>(
    '/sessions',
    title === undefined ? {} : { title },
  );
  return data;
}

export async function renameSession(id: string, title: string): Promise<{ id: string; title: string }> {
  const { data } = await customerApi.patch<{ id: string; title: string }>(`/sessions/${id}`, { title });
  return data;
}

export async function deleteSession(id: string): Promise<void> {
  await customerApi.delete(`/sessions/${id}`);
}

/** 历史消息：返回的就是 useChat({ messages }) 能直接吃的形状 */
export async function fetchSessionMessages(
  id: string,
  limit = 100,
): Promise<{ messages: ChatUIMessage[]; has_more: boolean }> {
  const { data } = await customerApi.get<{ messages: ChatUIMessage[]; has_more: boolean }>(
    `/sessions/${id}/messages`,
    { params: { limit } },
  );
  return data;
}

/** 👍 / 👎 反馈；feedback 传 null 表示清除 */
export async function sendFeedback(
  messageId: string,
  feedback: 1 | -1 | null,
  feedbackText?: string,
): Promise<{ id: string; feedback: 1 | -1 | null }> {
  const { data } = await customerApi.post<{ id: string; feedback: 1 | -1 | null }>(
    `/messages/${messageId}/feedback`,
    feedback === null ? { feedback: null } : { feedback, feedback_text: feedbackText },
  );
  return data;
}

/**
 * 流式对话端点的 transport 配置。
 *
 * ⚠️ **token 必须在这里手动带上**：useChat 内部用 fetch 发请求，
 * **完全绕过 web/lib/apiShared.ts 的 axios 拦截器**。忘了带就是一路 401。
 *
 * headers 传函数而不是字符串：每次发请求时再读一次 localStorage，
 * 避免 token 刷新后还在用旧值。
 */
export function chatTransportOptions(sessionId: string): {
  api: string;
  headers: () => Record<string, string>;
} {
  return {
    api: `/api/v1/customer/sessions/${sessionId}/messages`,
    headers: () => {
      const token = getToken();
      return token === null ? {} : { authorization: `Bearer ${token}` };
    },
  };
}

/** 把 SSE 流式请求的 URL 拼出来（给「停止生成」等需要手写 fetch 的地方用） */
export function chatStreamUrl(sessionId: string): string {
  return `/api/v1/customer/sessions/${sessionId}/messages`;
}

/**
 * 从 axios 错误里取出后端返回的可读消息。
 * 与 adminKnowledge.ts 的同名函数同构（后端错误体 { code, message, details }）。
 */
/**
 * 流式对话的错误文案。
 *
 * ⚠️ useChat 的 transport 失败时抛的是**普通 Error**，`message` 里塞的是
 *    后端的原始响应体（JSON 字符串），不是 `response.data.message`：
 *      {"code":"CONTENT_BLOCKED","message":"检测到提示词注入，已拒绝该请求",...}
 *    直接把 `error.message` 显示给用户会看到一坨 JSON —— 这里解析成中文文案。
 */
export function streamErrorMessage(err: unknown, fallback: string): string {
  const raw = (err as { message?: string } | undefined)?.message ?? '';
  if (raw === '') {
    return fallback;
  }
  try {
    const parsed = JSON.parse(raw) as { message?: unknown };
    if (typeof parsed.message === 'string' && parsed.message !== '') {
      return parsed.message;
    }
  } catch {
    // 不是 JSON（比如网络错误），用原文
  }
  return raw;
}

export function errorMessage(err: unknown, fallback: string): string {
  const e = err as {
    response?: { status?: number; data?: { message?: string } };
    message?: string;
  };
  const status = e.response?.status;
  const serverMessage = e.response?.data?.message;
  if (status !== undefined && serverMessage !== undefined) {
    return serverMessage;
  }
  if (status !== undefined) {
    return `${fallback}（HTTP ${status}）`;
  }
  return e.message ?? fallback;
}