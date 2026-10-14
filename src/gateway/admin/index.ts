/**
 * admin 子系统 barrel（租户后台：admin / agent）
 *
 * 路由前缀：/api/v1/admin/*
 * 鉴权：admin 角色（requireAdmin）
 */
export { adminUserRouter } from './user-routes';
export { adminAuthRouter } from './auth-routes';
export { requireAdmin } from './middleware';
