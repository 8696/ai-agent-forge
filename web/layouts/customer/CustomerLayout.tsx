import type { ReactElement } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { SharedShellLayout } from '../SharedShellLayout';
import { RequireAuth } from '../../components/RequireAuth';
import type { SidebarItem } from '../SharedShellLayout';
import { MessageOutlined, DashboardOutlined, BookOutlined } from '@ant-design/icons';

/**
 * customer 子系统 Layout（租户前台）
 * - role=customer 才能进
 * - 侧栏：首页（工作台）/ 智能问答 / 我的记忆
 */
const SIDEBAR: SidebarItem[] = [
  { key: '/customer', icon: <DashboardOutlined />, label: '首页', to: '/customer' },
  { key: '/customer/chat', icon: <MessageOutlined />, label: '智能问答', to: '/customer/chat' },
  { key: '/customer/memories', icon: <BookOutlined />, label: '我的记忆', to: '/customer/memories' },
];

export function CustomerLayout(): ReactElement {
  const location = useLocation();

  // 登录页 / 改密页：整屏（AuthShell 自带整页背景），不套前台外壳
  if (
    location.pathname === '/customer/login' ||
    location.pathname === '/customer/change-password'
  ) {
    return <Outlet />;
  }

  return (
    <RequireAuth
      role="customer"
      loginPath="/customer/login"
      changePasswordPath="/customer/change-password"
    >
      <SharedShellLayout
        role="customer"
        brandLabel="用户中心"
        roleHint="用户中心"
        sidebarItems={SIDEBAR}
      >
        <Outlet />
      </SharedShellLayout>
    </RequireAuth>
  );
}

