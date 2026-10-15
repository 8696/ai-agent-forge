import type { ReactElement } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { SharedShellLayout } from '../SharedShellLayout';
import type { SidebarItem } from '../SharedShellLayout';
import { DashboardOutlined, TeamOutlined } from '@ant-design/icons';

/**
 * admin 子系统 Layout（租户后台）
 * - role=admin 才能进
 * - 只放已经落地的菜单；未实现的入口不占位
 */
const SIDEBAR: SidebarItem[] = [
  { key: '/admin', icon: <DashboardOutlined />, label: '首页', to: '/admin' },
  { key: '/admin/users', icon: <TeamOutlined />, label: '用户', to: '/admin/users' },
];

export function AdminLayout(): ReactElement {
  const location = useLocation();

  if (location.pathname === '/admin/login') {
    return <Outlet />;
  }

  if (typeof window !== 'undefined') {
    const token = window.localStorage.getItem('agent_platform_token');
    if (token === null) {
      return <Navigate to="/admin/login" replace />;
    }
    const roleFromToken = readRoleFromToken(token);
    if (roleFromToken !== null && roleFromToken !== 'admin') {
      return <Navigate to="/" replace />;
    }
  }

  return (
    <SharedShellLayout
      role="admin"
      brandLabel="租户后台"
      roleHint="租户后台"
      sidebarItems={SIDEBAR}
    >
      <Outlet />
    </SharedShellLayout>
  );
}

function readRoleFromToken(token: string): string | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1] ?? '')) as { role?: unknown };
    return typeof payload.role === 'string' ? payload.role : null;
  } catch {
    return null;
  }
}
