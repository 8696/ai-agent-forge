import type { ReactElement } from 'react';
import { Navigate } from 'react-router-dom';
import { getCurrentUser } from '../lib/auth';

/**
 * 根路径 smart redirect（docs/04-UI需求 + Step 3 验收）
 *
 * 规则（每套子系统都有自己的路由前缀）：
 *   未登录 → /customer/login（默认走 customer 前台登录页）
 *   system → /system    （SaaS 平台方后台）
 *   admin → /admin    （租户后台）
 *   customer → /customer       （租户前台）
 */
export function RootRedirect(): ReactElement {
  const user = getCurrentUser();
  if (user === null) {
    return <Navigate to="/customer/login" replace />;
  }
  switch (user.role) {
    case 'system':
      return <Navigate to="/system" replace />;
    case 'admin':
      return <Navigate to="/admin" replace />;
    case 'customer':
      return <Navigate to="/customer" replace />;
  }
}
