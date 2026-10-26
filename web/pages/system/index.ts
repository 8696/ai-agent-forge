/**
 * system 子系统：登录页 + 平台管理页（SaaS 平台方）
 * 详见 docs/12-e §F1 + docs/04-a-ui-总则布局与菜单.md §3
 * 路由前缀：/system/*（前端）/api/v1/system/*（后端）
 */
export { SystemLoginPage } from './SystemLoginPage';
export { SystemChangePasswordPage } from './SystemChangePasswordPage';
export { SystemHomePage } from './SystemHomePage';
export { SystemTenantsPage } from './TenantsPage';
export { SystemTenantDetailPage } from './TenantDetailPage';
export { SystemAuditPage } from './SystemAuditPage';
