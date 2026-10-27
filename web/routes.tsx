import { createBrowserRouter, type RouteObject } from 'react-router-dom';
import { RootRedirect } from './components/RootRedirect';
import { DevProbePage } from './pages/DevProbePage';
import { NotFoundPage } from './pages/NotFoundPage';
import {
  SystemLoginPage,
  SystemHomePage,
  SystemTenantsPage,
  SystemTenantDetailPage,
  SystemChangePasswordPage,
  SystemAuditPage,
} from './pages/system';
import {
  AdminLoginPage,
  AdminHomePage,
  AdminUsersPage,
  AdminAuditLogsPage,
  AdminApiKeysPage,
  AdminMemoriesPage,
  ToolsPage,
  ToolLogsPage,
  KnowledgeDocumentsPage,
  KnowledgeSearchPage,
  KnowledgeChunksPage,
  ModelListPage,
  PromptEditorPage,
  SettingsPage,
  ObservabilityTraceListPage,
  ObservabilityTraceDetailPage,
  ObservabilityCostPage,
  ObservabilityAlertsPage,
  EvaluationComparePage,
  EvaluationDatasetsPage,
  EvaluationRunsPage,
  AdminChangePasswordPage,
} from './pages/admin';
import {
  CustomerLoginPage,
  HomePage,
  ChatPage,
  CustomerMemoriesPage,
  CustomerChangePasswordPage,
} from './pages/customer';
import { WidgetPage } from './pages/widget';
import { SystemLayout } from './layouts/system/SystemLayout';
import { AdminLayout } from './layouts/admin/AdminLayout';
import { CustomerLayout } from './layouts/customer/CustomerLayout';

/**
 * 路由表 —— 3 套子系统各自独立（详见 docs/03 §B.5）
 *
 *   /                → RootRedirect（按登录态分流到对应子系统首页）
 *   /system/*        → SystemLayout（含 /system/login 自己的 layout + auth）
 *   /admin/*         → AdminLayout
 *   /customer/*      → CustomerLayout
 *   /widget/:tenantCode → 公开聊天挂件（E1，免登录）
 *   /dev/probe       → 公开调试页（dev only）
 *   *                → NotFoundPage
 *
 * 未来按 docs/04-a-ui-总则布局与菜单.md §3 增加：
 *   /admin/*            11 个管理页面（Step 13 落）
 *   /customer/*         租户前台业务页
 */
const routes: RouteObject[] = [
  { path: '/', element: <RootRedirect /> },

  // ===== system 子系统（SaaS 平台方）=====
  {
    path: '/system',
    element: <SystemLayout />,
    children: [
      { index: true, element: <SystemHomePage /> },
      { path: 'login', element: <SystemLoginPage /> },
      { path: 'change-password', element: <SystemChangePasswordPage /> },
      { path: 'tenants', element: <SystemTenantsPage /> },
      { path: 'tenants/:id', element: <SystemTenantDetailPage /> },
      // 平台方的审计日志（跨租户视角）—— docs/04-d §6.1
      { path: 'audit', element: <SystemAuditPage /> },
    ],
  },

  // ===== admin 子系统（租户后台）=====
  {
    path: '/admin',
    element: <AdminLayout />,
    children: [
      { index: true, element: <AdminHomePage /> },
      { path: 'login', element: <AdminLoginPage /> },
      { path: 'change-password', element: <AdminChangePasswordPage /> },
      { path: 'users', element: <AdminUsersPage /> },
      { path: 'memories', element: <AdminMemoriesPage /> },
      { path: 'knowledge/documents', element: <KnowledgeDocumentsPage /> },
      { path: 'knowledge/test', element: <KnowledgeSearchPage /> },
      { path: 'knowledge/chunks', element: <KnowledgeChunksPage /> },
      { path: 'models', element: <ModelListPage /> },
      { path: 'prompts', element: <PromptEditorPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'observability/traces', element: <ObservabilityTraceListPage /> },
      { path: 'observability/traces/:id', element: <ObservabilityTraceDetailPage /> },
      { path: 'observability/cost', element: <ObservabilityCostPage /> },
      { path: 'observability/alerts', element: <ObservabilityAlertsPage /> },
      { path: 'evaluation/datasets', element: <EvaluationDatasetsPage /> },
      { path: 'evaluation/runs', element: <EvaluationRunsPage /> },
      { path: 'evaluation/compare', element: <EvaluationComparePage /> },
      { path: 'audit', element: <AdminAuditLogsPage /> },
      { path: 'api-keys', element: <AdminApiKeysPage /> },
      { path: 'tools', element: <ToolsPage /> },
      { path: 'tool-logs', element: <ToolLogsPage /> },
    ],
  },

  // ===== customer 子系统（租户前台）=====
  {
    path: '/customer',
    element: <CustomerLayout />,
    children: [
      // 首页 = 用户中心工作台（B7）：欢迎语 / 推荐问题 / 最近会话 / 知识库 / 我的记忆
      { index: true, element: <HomePage /> },
      { path: 'chat', element: <ChatPage /> },
      { path: 'memories', element: <CustomerMemoriesPage /> },
      { path: 'login', element: <CustomerLoginPage /> },
      { path: 'change-password', element: <CustomerChangePasswordPage /> },
    ],
  },

  // 公开
  // E1 公开聊天挂件：免登录，租户靠 URL 里的 tenantCode 定位
  { path: '/widget/:tenantCode', element: <WidgetPage /> },
  // ⚠️ 调试页**只在 Vite dev 模式下注册** —— 生产构建里这个路由不存在（落到 404）。
  //    以前它对所有人开放，而它挂的 LLM 探活会拿进程级凭据去调模型。
  ...(import.meta.env.DEV ? [{ path: '/dev/probe', element: <DevProbePage /> }] : []),
  { path: '*', element: <NotFoundPage /> },
];

export const router = createBrowserRouter(routes);
