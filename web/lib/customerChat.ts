import { customerApi } from './customerApi';
import { getToken, setToken } from './apiFactory';
import { apiErrorMessage } from './apiError';
import type { ChatMessageMetadata, ChatUIMessage, SessionListItem } from '@shared/types/chat';

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

/**
 * 消息级元数据 —— 比 shared 的 `ChatMessageMetadata` 多两个字段。
 *
 * 后端 `rowToUiMessage`（src/services/chat.ts）会把这两个字段带出来：
 *  - `feedback` 👍/👎：刷新后要还原成「已选中」，不然再点一次是「又赞一次」而不是取消
 *  - `favorite` 📌：消息级收藏（迁移 037）
 *
 * ⚠️ shared 那份是跨包的公共契约，改动面要小 —— 所以扩展类型放在这里，
 *    两个聊天页都从这儿读。
 */
export interface ChatMessageMeta extends ChatMessageMetadata {
  feedback?: 1 | -1 | null;
  favorite?: boolean;
}

/** 读一条消息的元数据（feedback / favorite） */
export function messageMeta(m: ChatUIMessage): ChatMessageMeta {
  return (m.metadata ?? {}) as ChatMessageMeta;
}

/**
 * 完整时间 —— 用户消息右上角小时间戳 hover 时显示（docs/04-b §4.2）
 *
 * `formatMessageTime` 只给到分钟（今天 HH:mm / 今年 MM-DD HH:mm / 更早 YYYY-MM-DD HH:mm），
 * hover 要看的是**完整**日期时间，所以这里另给一个。
 */
export function formatFullTime(iso: string | undefined): string {
  if (iso === undefined || iso === '') {
    return '';
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return '';
  }
  return d.toLocaleString();
}

export async function fetchSessions(
  page = 1,
  pageSize = 50,
  favoriteOnly = false,
): Promise<{
  sessions: SessionListItem[];
  pagination: SessionPagination;
}> {
  const { data } = await customerApi.get<{
    sessions: SessionListItem[];
    pagination: SessionPagination;
  }>('/sessions', {
    params: { page, page_size: pageSize, ...(favoriteOnly ? { favorite: 'true' } : {}) },
  });
  return data;
}

/**
 * 收藏 / 取消收藏（12-e 裁定表 #7）
 *
 * `favorite` 不传 = 切换；传 true / false = 设成指定状态。
 */
export async function setSessionFavorite(
  id: string,
  favorite?: boolean | null,
): Promise<{ id: string; favorite: boolean }> {
  const { data } = await customerApi.patch<{ id: string; favorite: boolean }>(
    `/sessions/${encodeURIComponent(id)}/favorite`,
    favorite === undefined ? {} : { favorite },
  );
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
 * 📌 消息级收藏（docs/04-b §4.2 的操作行）
 *
 * 与会话级收藏（`setSessionFavorite`）是两回事：
 * 会话收藏是「这一段对话重要」，消息收藏是「这一条回答值得留着」。
 *
 * ⚠️ 挂件页**没有**这个按钮 —— 挂件是匿名会话，收藏没有持久归属语义。
 */
export async function setMessageFavorite(
  messageId: string,
  favorite: boolean,
): Promise<{ id: string; favorite: boolean }> {
  const { data } = await customerApi.patch<{ id: string; favorite: boolean }>(
    `/messages/${encodeURIComponent(messageId)}/favorite`,
    { favorite },
  );
  return data;
}

/**
 * 确认一次敏感工具调用（B3 HITL）。
 *
 * 用户在工具调用卡片上点「确认执行」时调它。
 * 确认绑定到「工具名 + 那次调用的入参」—— 入参变了要重新确认。
 */
export async function approveToolCall(
  sessionId: string,
  toolName: string,
  args: unknown,
): Promise<{ ok: boolean; tool_name: string; approval_key: string }> {
  const { data } = await customerApi.post<{
    ok: boolean;
    tool_name: string;
    approval_key: string;
  }>(`/sessions/${sessionId}/tool-approvals`, { tool_name: toolName, args });
  return data;
}

/**
 * 取消一次敏感工具调用（B3 HITL）。
 *
 * 用户点了「确认执行」还能反悔 —— 取消之后闸门会回「用户拒绝执行这个操作」，
 * 模型如实告诉用户，不会再问第三次。
 */
export async function rejectToolCall(
  sessionId: string,
  toolName: string,
  args: unknown,
): Promise<{ ok: boolean; tool_name: string; approval_key: string }> {
  const { data } = await customerApi.post<{
    ok: boolean;
    tool_name: string;
    approval_key: string;
  }>(`/sessions/${sessionId}/tool-approvals/reject`, { tool_name: toolName, args });
  return data;
}

/**
 * 流式请求的 fetch 包装：**401 时清 token + 跳登录页**。
 *
 * ⚠️ **为什么必须自己包一层**：
 *    `useChat` 内部用 `fetch` 发请求，**完全绕过 axios 拦截器** ——
 *    `web/lib/apiFactory.ts` 的 `onUnauthorized`（401 → 清 token → 跳登录）
 *    只挂在 axios 上。所以流式请求 401 时**只会变成一条错误 Alert**，
 *    用户停在白屏 / 错误态，token 还在（下次请求继续 401）。
 *
 * 这里复刻 axios 那条路径的语义：清 token + 跳**本子系统**的登录页。
 * （`apiFactory.ts` 归别的 agent 管，这里不碰它。）
 */
async function customerChatFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  if (response.status === 401) {
    setToken(null);
    if (!window.location.pathname.startsWith('/customer/login')) {
      window.location.replace('/customer/login');
    }
  }
  return response;
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
export function chatTransportOptions(
  sessionId: string,
  /**
   * 额外的请求体字段（docs/04-b §4.4 的「思考模式」开关就靠它传）。
   *
   * ⚠️ 必须是**函数** —— transport 只在 sessionId 变化时重建，
   *    传固定值的话勾选状态会被冻在创建那一刻。
   */
  body?: () => Record<string, unknown>,
): {
  api: string;
  headers: () => Record<string, string>;
  fetch: typeof globalThis.fetch;
  body?: () => Record<string, unknown>;
} {
  return {
    api: `/api/v1/customer/sessions/${sessionId}/messages`,
    headers: () => {
      const token = getToken();
      return token === null ? {} : { authorization: `Bearer ${token}` };
    },
    // 401 → 清 token + 跳登录（见 customerChatFetch 的注释）
    fetch: customerChatFetch,
    ...(body !== undefined ? { body } : {}),
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

/**
 * 从 axios 错误里取出该给用户看的话。
 *
 * ⚠️ **唯一实现在 `web/lib/apiError.ts`** —— 这里只是兼容别名。
 *    旧版各抄一份的实现只区分「有没有服务器消息」，把 403 → 「没有权限」、
 *    500 → 「服务异常，已记录」这两条规格文案丢了（用户看到的是英文
 *    `'Forbidden'` 和 `'服务器内部错误'`）。
 */
export const errorMessage = apiErrorMessage;