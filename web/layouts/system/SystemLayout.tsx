import type { ReactElement } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { SharedShellLayout } from '../SharedShellLayout';
import type { SidebarItem } from '../SharedShellLayout';
import { DashboardOutlined, ShopOutlined } from '@ant-design/icons';

/**
 * system 子系统 Layout（SaaS 平台方后台）
 * - role=system 才能进
 * - 只放已经落地的菜单
 */
const SIDEBAR: SidebarItem[] = [
  { key: '/system', icon: <DashboardOutlined />, label: '总览', to: '/system' },
  {
    key: '/system/tenants',
    icon: <ShopOutlined />,
    label: '租户',
    to: '/system/tenants',
  },
];

export function SystemLayout(): ReactElement {
  const location = useLocation();

  if (location.pathname === '/system/login') {
    return <Outlet />;
  }

  if (typeof window !== 'undefined') {
    const token = window.localStorage.getItem('agent_platform_token');
    if (token === null) {
      return <Navigate to="/system/login" replace />;
    }
    const roleFromToken = readRoleFromToken(token);
    if (roleFromToken !== null && roleFromToken !== 'system') {
      return <Navigate to="/" replace />;
    }
  }

  return (
    <SharedShellLayout
      role="system"
      brandLabel="平台管理"
      roleHint="平台管理"
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
