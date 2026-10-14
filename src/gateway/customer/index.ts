/**
 * customer 子系统 barrel（租户前台：customer 角色）
 *
 * 当前只暴露 auth（POST /login），其他 customer 功能（me / chat / sessions）已清空。
 */
export { customerAuthRouter } from './auth-routes';
