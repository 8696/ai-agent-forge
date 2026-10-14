import type { Context, Next } from 'koa';
import { verifyToken, type JwtPayload } from '../lib/jwt';
import { AuthError } from '../lib/errors';

/**
 * 公共 base JWT 验证 —— 详见 docs/16-需求技术对照表 A2 / A3
 *
 * 仅做：
 * - 解析 Authorization: Bearer <token>
 * - jwt.verify 签名 + 过期
 * - 把 payload 塞到 ctx.state.user（discriminated union）
 *
 * 角色校验由各子系统的 middleware 做（system/ admin/ account/ auth/）
 */
export async function jwtAuth(ctx: Context, next: Next): Promise<void> {
  const auth = ctx.request.headers.authorization;
  if (auth === undefined || !auth.startsWith('Bearer ')) {
    throw new AuthError('未提供 token');
  }
  const token = auth.slice('Bearer '.length).trim();
  if (token === '') {
    throw new AuthError('token 为空');
  }
  const payload: JwtPayload = verifyToken(token);
  ctx.state.user = payload;
  await next();
}
