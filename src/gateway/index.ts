/**
 * Gateway 层顶层 barrel —— 3 个独立子系统（按业务边界完全分桶）
 *
 * 详见 docs/03-技术栈与规范.md §B.5
 *
 * - system/   SaaS 平台方子系统（/api/v1/system/*，role=system）
 * - admin/     租户后台子系统（/api/v1/admin/*，role ∈ {admin, agent}）
 * - customer/  租户前台子系统（/api/v1/customer/*，role=customer）
 *
 * 每个子系统 auth 自闭环（login / me / change-password 全在自己桶里）；
 * 没有跨子系统的共享 auth namespace。
 *
 * 公共：errorHandler / healthRouter / activeConfigRouter / devProbeRouter / jwtAuth
 */
export { errorHandler } from './error-handler';
export { healthRouter } from './health-routes';
export { activeConfigRouter } from './active-config-routes';
export { devProbeRouter } from './dev-probe-routes';
export { jwtAuth } from './jwt-base';

export { systemTenantRouter, systemAuthRouter, requireSystemUser } from './system';
export { adminUserRouter, adminAuthRouter, adminKnowledgeRouter, requireAdmin } from './admin';
export { customerAuthRouter, requireCustomer } from './customer';
