/**
 * customer 子系统：租户前台页面（customer 角色）
 *
 * - login  登录页
 * - home   用户中心首页 / 工作台（B7，详见 docs/12-b-需求-ai对话能力.md §B7）
 * - chat   智能问答（B1，详见 docs/04-b-ui-登录与聊天挂件.md §4）
 *
 * 路由前缀：/customer/*（前端）/api/v1/customer/*（后端）
 */
export { CustomerLoginPage } from './CustomerLoginPage';
export { CustomerChangePasswordPage } from './CustomerChangePasswordPage';
export { HomePage } from './HomePage';
export { ChatPage } from './ChatPage';
export { CustomerMemoriesPage } from './MemoriesPage';
