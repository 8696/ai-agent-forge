/**
 * system 子系统 barrel（SaaS 开发者后台）
 *
 * 路由前缀：/api/v1/system/*
 * 鉴权：system user（requireSystemUser，role=system）
 */
export { systemTenantRouter } from './tenant-routes';
export { systemAuthRouter } from './auth-routes';
export { systemAuditRouter } from './audit-routes';
export { requireSystemUser } from './middleware';
