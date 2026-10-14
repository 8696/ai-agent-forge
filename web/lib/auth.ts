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
    return result;
  } catch {
    return null;
  }
}

export function logout(): void {
  setToken(null);
}
