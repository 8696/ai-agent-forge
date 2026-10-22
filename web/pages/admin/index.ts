/**
 * admin 子系统：租户后台页面
 *
 * 路由前缀：/admin/*
 * 入口：web/routes.tsx 里把这些 page 组件挂到对应 path
 */
export { AdminLoginPage } from './AdminLoginPage';
export { AdminHomePage } from './AdminHomePage';
export { AdminUsersPage } from './UsersPage';
export { KnowledgeDocumentsPage } from './KnowledgeDocumentsPage';
export { KnowledgeSearchPage } from './KnowledgeSearchPage';
export { ModelListPage } from './ModelListPage';
export { SettingsPage } from './SettingsPage';
export { PromptEditorPage } from './PromptEditorPage';
