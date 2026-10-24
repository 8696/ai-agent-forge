/**
 * customer 子系统 barrel（租户前台：customer 角色）
 *
 * - auth-routes  只暴露 auth（POST /login）
 * - chat-routes  会话 CRUD + 历史消息 + ★ 流式对话（SSE）+ 反馈
 * - middleware   requireCustomer（role=customer）
 *
 * 另外导出 `runChatTurn` —— E1 的公开挂件（/api/v1/public/widget/*）和
 * 对外 REST API（/api/v1/public/*）要复用 customer 这条链路的
 * 「限流 → 审核 → 检索 → 生成 → 落库 → 记账」全流程，所以把执行器提到这里。
 *
 * ⚠️ 复用的是**业务链路**，不是鉴权：public 那两个子系统有自己独立的鉴权
 *    （挂件用匿名会话 token，对外 API 用 API Key），跟 customer 的 JWT
 *    完全不共享命名空间。
 *
 * 详见 docs/12-b-需求-ai对话能力.md §B1 / docs/12-e-需求-业务接入与平台运营.md §E1
 */
export { customerAuthRouter } from './auth-routes';
export { customerChatRouter, runChatTurn } from './chat-routes';
export type { ChatTurnOptions, ChatTurnResult } from './chat-routes';
export { customerMemoryRouter } from './memory-routes';
export { requireCustomer } from './middleware';
