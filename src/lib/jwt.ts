import jwt from 'jsonwebtoken';
import { config } from '../config';
import { AuthError } from './errors';

/**
 * JWT 签发 / 校验 —— 详见 docs/16-需求技术对照表 A2（payload 字段名约定）
 *
 * payload 三类：
 * - system user: { sub, role: 'system' } （system 子系统用）
 * - tenant user: { sub, tenant_id, role } （后台 / 前台用户用）
 */

export interface SystemJwtPayload {
  sub: string; // system user id
  role: 'system';
}

export interface TenantUserJwtPayload {
  sub: string; // user id
  tenant_id: string;
  role: 'admin' | 'customer';
}

export type JwtPayload = SystemJwtPayload | TenantUserJwtPayload;

export function signToken(payload: JwtPayload): string {
  // 走 jwt.sign 同步重载（payload, secret, options → string）
  // .env 里 expiresIn 是 string，jsonwebtoken@9 期望 ms.StringValue 字面量；运行时校验
  return jwt.sign(payload, config.JWT_SECRET, {
    expiresIn: config.JWT_EXPIRES_IN as unknown as number,
  });
}

export function verifyToken(token: string): JwtPayload {
  try {
    const decoded = jwt.verify(token, config.JWT_SECRET);
    if (typeof decoded !== 'object' || decoded === null) {
      throw new AuthError('无效的 token');
    }
    return decoded as JwtPayload;
  } catch (err) {
    if (err instanceof AuthError) throw err;
    throw new AuthError('无效或过期的 token');
  }
}
