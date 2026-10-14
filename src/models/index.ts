/**
 * 模型 barrel —— 对外只通过此文件导出，禁止外部直接 import 具体模型文件。
 * 详见 docs/03-技术栈-工程化规范.md §A.15
 */
export { Tenant } from './Tenant';
export type { TenantPlan, TenantStatus, TenantSettings } from './Tenant';
export { User } from './User';
export type { UserRole, UserPreferences } from './User';
export { SystemUser } from './SystemUser';
export type { SystemUserRole } from './SystemUser';
export { ApiKey } from './ApiKey';
export { AuditLog } from './AuditLog';
export type { AuditAction } from './AuditLog';
export { Document } from './Document';
export type { DocumentStatus, DocumentMetadata } from './Document';
