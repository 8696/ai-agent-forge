/**
 * public 子系统 barrel —— E1（docs/12-e-需求-业务接入与平台运营.md §E1）
 *
 * 这一层是**对外**的：跟 system / admin / customer 三个子系统并列，
 * 但鉴权完全独立 —— 不认 JWT，也不发 JWT。
 *
 *   publicWidgetRouter      /api/v1/public/widget/*    公开挂件（免登录）
 *                           鉴权：URL 里的 tenant code + 请求头里的匿名会话 token
 *
 *   publicApiRouter         /api/v1/public/*           对外 REST API
 *                           鉴权：API Key（Authorization: Bearer ak_xxx / X-API-Key）
 *
 *   publicAdminApiRouter    /api/v1/public/*           对外 REST API 的 admin 档
 *                           （知识库管理：文档列表 / 上传 / 删除）
 *                           鉴权：同上，但**必须是 admin 档的 key**
 *
 *   publicApiKeyAdminRouter /api/v1/admin/api-keys     租户后台管自己的 API Key
 *                           鉴权：admin 的 JWT（URL 前缀属于 admin 命名空间，
 *                           但代码物理上在本目录 —— 见 api-key-admin-routes.ts 的注释）
 *
 * ⚠️ 两条对外链路复用 customer 那套 RAG + LLM 链路（runChatTurn），
 *    但**鉴权命名空间互不相通**：public 的凭据调不了 admin / customer，
 *    反过来也一样。
 */
export { publicWidgetRouter, WIDGET_TOKEN_HEADER } from './widget-routes';
export { publicApiRouter } from './api-routes';
export { publicAdminApiRouter } from './admin-api-routes';
export { publicApiKeyAdminRouter } from './api-key-admin-routes';
export { signWidgetToken, verifyWidgetToken } from './widget-token';
