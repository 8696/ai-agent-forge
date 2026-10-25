import type { ReactElement, ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { getCurrentUser, type UserRole } from '../lib/auth';

/**
 * 路由守卫 —— docs/04-d §7 公共组件 / §11.3「JWT 过期自动跳登录」
 *
 * 三套子系统（system / admin / customer）的 Layout 都要做同一套检查：
 *   1. 没有 token → 跳本子系统的登录页
 *   2. token 的角色不对 → 跳 `/`（RootRedirect 按角色分流到对应子系统）
 *   3. 被平台方重置过密码（`must_change_password`）→ 跳改密页
 *      —— 服务端也会挡（src/gateway/password-change-gate.ts），这里只是
 *      「别让用户到处乱点」
 *
 * ⚠️ **每个子系统各用各的登录页**（`/admin/login` / `/customer/login` / `/system/login`）——
 *    跨子系统跳登录页会让「admin 的 token 过期」把人送到 customer 的登录页，
 *    体验上很怪（虽然安全上没错）。
 */
interface RequireAuthProps {
  /** 允许进入的角色 */
  role: UserRole;
  /** 没登录时跳哪儿 */
  loginPath: string;
  /** 强制改密时跳哪儿；不传 = 不做强制改密跳转 */
  changePasswordPath?: string;
  children: ReactNode;
}

export function RequireAuth(props: RequireAuthProps): ReactElement {
  const location = useLocation();
  const user = getCurrentUser();

  if (user === null) {
    // 没登录（或 token 解析不出来）→ 回登录页。
    // ⚠️ `replace` 而不是 `push`：登录完不该再按「后退」回到受保护的页面。
    return <Navigate to={props.loginPath} replace state={{ from: location.pathname }} />;
  }

  if (user.role !== props.role) {
    // 角色不对 —— 回根路径，让 RootRedirect 按当前 token 的角色分流
    return <Navigate to="/" replace />;
  }

  if (
    props.changePasswordPath !== undefined &&
    user.must_change_password === true &&
    location.pathname !== props.changePasswordPath
  ) {
    return <Navigate to={props.changePasswordPath} replace />;
  }

  return <>{props.children}</>;
}
