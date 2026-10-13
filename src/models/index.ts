/**
 * 模型 barrel —— 对外只通过此文件导出，禁止外部直接 import 具体模型文件。
 * 详见 docs/03-技术栈与规范.md §A.15
 */
export { Tenant } from './Tenant';
export type { TenantPlan, TenantSettings } from './Tenant';
export { User } from './User';
export type { UserRole, UserPreferences } from './User';
