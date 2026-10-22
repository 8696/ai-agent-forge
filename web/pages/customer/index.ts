/**
 * customer 子系统：租户前台页面（customer 角色）
 *
 * - login  登录页
 * - chat   智能问答（B1，详见 docs/04-b-ui-登录与聊天挂件.md §4）
 *
 * 路由前缀：/customer/*（前端）/api/v1/customer/*（后端）
 */
export { CustomerLoginPage } from './CustomerLoginPage';
export { ChatPage } from './ChatPage';