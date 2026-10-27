/**
 * admin 子系统：租户后台页面
 *
 * 路由前缀：/admin/*
 * 入口：web/routes.tsx 里把这些 page 组件挂到对应 path
 */
export { AdminLoginPage } from './AdminLoginPage';
export { AdminChangePasswordPage } from './AdminChangePasswordPage';
export { AdminHomePage } from './AdminHomePage';
export { AdminUsersPage } from './UsersPage';
export { AdminAuditLogsPage } from './AuditLogsPage';
export { AdminApiKeysPage } from './ApiKeysPage';
export { ToolsPage } from './ToolsPage';
export { ToolLogsPage } from './ToolLogsPage';
export { AdminMemoriesPage } from './MemoriesPage';
export { KnowledgeDocumentsPage } from './KnowledgeDocumentsPage';
export { KnowledgeSearchPage } from './KnowledgeSearchPage';
export { KnowledgeChunksPage } from './KnowledgeChunksPage';
export { ModelListPage } from './ModelListPage';
export { SettingsPage } from './SettingsPage';
export { PromptEditorPage } from './PromptEditorPage';
export { ObservabilityTraceListPage } from './ObservabilityTraceListPage';
export { ObservabilityTraceDetailPage } from './ObservabilityTraceDetailPage';
export { ObservabilityCostPage } from './ObservabilityCostPage';
export { ObservabilityAlertsPage } from './ObservabilityAlertsPage';
export { EvaluationComparePage } from './EvaluationComparePage';
export { EvaluationDatasetsPage } from './EvaluationDatasetsPage';
export { EvaluationRunsPage } from './EvaluationRunsPage';
