import { createBrowserRouter, type RouteObject } from 'react-router-dom';
import { RootRedirect } from './components/RootRedirect';
import { DevProbePage } from './pages/DevProbePage';
import { NotFoundPage } from './pages/NotFoundPage';
import {
  SystemLoginPage,
  SystemHomePage,
  SystemTenantsPage,
  SystemTenantDetailPage,
} from './pages/system';
import {
  AdminLoginPage,
  AdminHomePage,
  AdminUsersPage,
  KnowledgeDocumentsPage,
  KnowledgeSearchPage,
} from './pages/admin';
import { CustomerLoginPage } from './pages/customer';
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
 *   /dev/probe       → 公开调试页（dev only）
 *   *                → NotFoundPage
 *
 * 未来按 docs/04-UI需求.md §3 增加：
 *   /widget/:tenantId   公开聊天挂件
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
      { path: 'tenants', element: <SystemTenantsPage /> },
      { path: 'tenants/:id', element: <SystemTenantDetailPage /> },
    ],
  },

  // ===== admin 子系统（租户后台）=====
  {
    path: '/admin',
    element: <AdminLayout />,
    children: [
      { index: true, element: <AdminHomePage /> },
      { path: 'login', element: <AdminLoginPage /> },
      { path: 'users', element: <AdminUsersPage /> },
      // Step 4：知识库管理（P8）+ 检索测试
      { path: 'knowledge/documents', element: <KnowledgeDocumentsPage /> },
      { path: 'knowledge/test', element: <KnowledgeSearchPage /> },
    ],
  },

  // ===== customer 子系统（租户前台）=====
  {
    path: '/customer',
    element: <CustomerLayout />,
    children: [
      // 当前只暴露 login；其他 customer 功能（home / chat / sessions）已清空
      { path: 'login', element: <CustomerLoginPage /> },
    ],
  },

  // 公开
  { path: '/dev/probe', element: <DevProbePage /> },
  { path: '*', element: <NotFoundPage /> },
];

export const router = createBrowserRouter(routes);
