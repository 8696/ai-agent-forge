/**
 * admin 子系统 barrel（租户后台：admin / agent）
 *
 * 路由前缀：/api/v1/admin/*
 * 鉴权：admin 角色（requireAdmin）
 */
import { adminUserRouter } from './user-routes';
import { adminAuditRouter } from './audit-routes';

export { adminUserRouter } from './user-routes';
export { adminAuthRouter } from './auth-routes';
export { adminKnowledgeRouter } from './knowledge-routes';
export { adminConfigRouter } from './config-routes';
export { adminObservabilityRouter } from './observability-routes';
export { adminEvaluationRouter } from './evaluation-routes';
export { adminMemoryRouter } from './memory-routes';
export { adminAuditRouter } from './audit-routes';
export { requireAdmin } from './middleware';
