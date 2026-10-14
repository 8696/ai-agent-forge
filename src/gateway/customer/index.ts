/**
 * customer 子系统 barrel（租户前台：customer 角色）
 *
 * 路由前缀：/api/v1/customer/*
 * 鉴权：customer 角色（requireCustomer）
 */
export { customerAuthRouter } from './auth-routes';
export { requireCustomer } from './middleware';
