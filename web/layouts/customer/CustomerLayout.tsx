import type { ReactElement } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { SharedShellLayout } from '../SharedShellLayout';
import type { SidebarItem } from '../SharedShellLayout';
import { MessageOutlined, DashboardOutlined, BookOutlined } from '@ant-design/icons';

/**
 * customer 子系统 Layout（租户前台）
 * - role=customer 才能进
 * - 侧栏：首页（= 聊天页）/ 智能问答 / 我的记忆
 */
const SIDEBAR: SidebarItem[] = [
  { key: '/customer', icon: <DashboardOutlined />, label: '首页', to: '/customer' },
  { key: '/customer/chat', icon: <MessageOutlined />, label: '智能问答', to: '/customer/chat' },
  { key: '/customer/memories', icon: <BookOutlined />, label: '我的记忆', to: '/customer/memories' },
];

export function CustomerLayout(): ReactElement {
  const location = useLocation();

  if (location.pathname === '/customer/login') {
    return <Outlet />;
  }

  if (typeof window !== 'undefined') {
    const token = window.localStorage.getItem('agent_platform_token');
    if (token === null) {
      return <Navigate to="/customer/login" replace />;
    }
    const roleFromToken = readRoleFromToken(token);
    if (roleFromToken !== null && roleFromToken !== 'customer') {
      return <Navigate to="/" replace />;
    }
  }

  return (
    <SharedShellLayout
      role="customer"
      brandLabel="用户中心"
      roleHint="用户中心"
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
