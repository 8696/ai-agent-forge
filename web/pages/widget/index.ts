/**
 * widget 子系统：公开聊天挂件（E1 落地）
 *
 * 路由：/widget/:tenantCode（公开，无需登录）
 * 入口：web/routes.tsx
 *
 * UI 规格：docs/04-b-ui-登录与聊天挂件.md §4.1-4.3
 * 后端：src/gateway/public/widget-routes.ts
 */
export { WidgetPage } from './WidgetPage';
