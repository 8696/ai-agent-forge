import jwt from 'jsonwebtoken';
import { config } from '../config';
import { AuthError } from './errors';

/**
 * JWT 签发 / 校验 —— 详见 docs/12-a §A2（payload 字段名约定）
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
  /**
   * **true = 这个账号必须先改密码**（平台方重置过密码 / 初始密码）。
   *
   * 放在 token 里（而不是每次查库）的原因：闸门要拦**每一个**请求，
   * 挂在 payload 上就不用为「查一下这个标志」给每个请求加一次 DB 往返。
   * 改完密码后端会签发一枚**新的** token（标志清掉），前端替换即可。
   */
  must_change_password?: boolean;
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
