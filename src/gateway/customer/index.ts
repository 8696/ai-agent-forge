/**
 * customer 子系统 barrel（租户前台：customer 角色）
 *
 * - auth-routes  只暴露 auth（POST /login）
 * - chat-routes  会话 CRUD + 历史消息 + ★ 流式对话（SSE）+ 反馈
 * - middleware   requireCustomer（role=customer）
 *
 * 详见 docs/12-b-需求-ai对话能力.md §B1
 */
export { customerAuthRouter } from './auth-routes';
export { customerChatRouter } from './chat-routes';
export { requireCustomer } from './middleware';