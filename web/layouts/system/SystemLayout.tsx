import type { ReactElement } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { SharedShellLayout } from '../SharedShellLayout';
import { RequireAuth } from '../../components/RequireAuth';
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

  // 登录页 / 改密页：整屏（AuthShell 自带整页背景），不套后台外壳。
  // ⚠️ system 用户**没有** must_change_password 标志（`system_users` 表里没这列），
  //    所以这里不存在「强制改密」—— 平台方账号由平台自己管。
  if (location.pathname === '/system/login' || location.pathname === '/system/change-password') {
    return <Outlet />;
  }

  return (
    <RequireAuth role="system" loginPath="/system/login">
      <SharedShellLayout
        role="system"
        brandLabel="平台管理"
        roleHint="平台管理"
        sidebarItems={SIDEBAR}
      >
        <Outlet />
      </SharedShellLayout>
    </RequireAuth>
  );
}

