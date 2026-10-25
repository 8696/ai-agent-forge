/**
 * Gateway 层顶层 barrel —— 4 个独立子系统（按业务边界完全分桶）
 *
 * 详见 docs/03-b-技术栈-后端栈.md §B.5
 *
 * - system/   SaaS 平台方子系统（/api/v1/system/*，role=system）
 * - admin/     租户后台子系统（/api/v1/admin/*，role ∈ {admin, agent}）
 * - customer/  租户前台子系统（/api/v1/customer/*，role=customer）
 * - public/    对外接入子系统（E1：/api/v1/public/*，鉴权 = API Key / 匿名会话 token）
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

export {
  systemTenantRouter,
  systemAuthRouter,
  requireSystemUser,
} from './system';
export {
  adminUserRouter,
  adminAuthRouter,
  adminKnowledgeRouter,
  adminConfigRouter,
  adminObservabilityRouter,
  adminEvaluationRouter,
  adminMemoryRouter,
  adminAuditRouter,
  requireAdmin,
} from './admin';
export {
  customerAuthRouter,
  customerChatRouter,
  customerMemoryRouter,
  customerProfileRouter,
  customerKnowledgeRouter,
  requireCustomer,
} from './customer';
export {
  publicWidgetRouter,
  publicApiRouter,
  publicApiKeyAdminRouter,
} from './public';
