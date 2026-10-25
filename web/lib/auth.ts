import { getToken, setToken } from './apiFactory';

/**
 * 前端 JWT 解析 —— 仅做 payload 解析 + 角色归一化
 * 详见 docs/16-需求技术对照表 A2（payload 字段）
 */

export type UserRole = 'system' | 'admin' | 'customer';

export interface UserInfo {
  sub: string;
  role: UserRole;
  email?: string;
  tenant_id?: string;
  /**
   * **true = 必须先改密码**（平台方重置过这个账号的密码）。
   *
   * 服务端把这个标志签进了 JWT —— 所以前端不用额外请求就能知道，
   * 登录后直接跳改密页即可。改完密码后端会换一枚新 token（标志清掉）。
   */
  must_change_password?: boolean;
}

export function getCurrentUser(): UserInfo | null {
  const token = getToken();
  if (token === null) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(atob(parts[1] as string)) as Record<string, unknown>;
    if (typeof payload.sub !== 'string' || typeof payload.role !== 'string') return null;
    if (!['system', 'admin', 'customer'].includes(payload.role)) return null;
    const result: UserInfo = { sub: payload.sub, role: payload.role as UserRole };
    if (typeof payload.tenant_id === 'string') {
      result.tenant_id = payload.tenant_id;
    }
    if (payload.must_change_password === true) {
      result.must_change_password = true;
    }
    return result;
  } catch {
    return null;
  }
}

export function logout(): void {
  setToken(null);
}
