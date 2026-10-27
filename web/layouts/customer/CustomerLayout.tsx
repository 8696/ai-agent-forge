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

  // 登录页：整屏（AuthShell 自带整页背景），不套前台外壳
  if (location.pathname === '/customer/login') {
    return <Outlet />;
  }

  // ⚠️ 改密页**仍然要过 RequireAuth**（2026-10-27 修）：
  // 以前这里是 `return <Outlet />` 直接放行 → 没登录的人能进改密页，
  // 提交后拿到 401，又因为「所有 change-password 的 401 都豁免」而被显示成
  // 「原密码不正确」→ 用户彻底懵。
  //
  // 「强制改密」不会死循环：RequireAuth 只在 `location.pathname !== changePasswordPath`
  // 时才跳改密页（改密页自己不在跳转条件里）。
  if (location.pathname === '/customer/change-password') {
    return (
      <RequireAuth
        role="customer"
        loginPath="/customer/login"
        changePasswordPath="/customer/change-password"
      >
        <Outlet />
      </RequireAuth>
    );
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

