import Router from '@koa/router';
import { z } from 'zod';
import { SystemUser } from '../../models';
import {
  verifyPassword,
  AuthError,
  signToken,
  recordFailedLogin,
  recordSuccessfulLogin,
  throwIfLocked,
  hashPassword,
  NotFoundError,
} from '../../lib';
import { jwtAuth } from '../jwt-base';
import { requireSystemUser } from './middleware';
import type { SystemJwtPayload } from '../../lib/jwt';

/**
 * systems 子系统：完整 auth 自闭环
 * 详见 docs/16-需求技术对照表 A4
 *
 * 路由（都挂在 /api/v1/system 下）：
 *   POST /login             不需鉴权
 *   GET  /me                jwtAuth + requireSystemUser
 *   POST /change-password   jwtAuth + requireSystemUser
 */
export const systemAuthRouter = new Router({ prefix: '/api/v1/system' });

const SystemLoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const ChangePasswordBody = z.object({
  old_password: z.string().min(1),
  new_password: z.string().min(8, '新密码至少 8 字符'),
});

systemAuthRouter.post('/login', async (ctx) => {
  const input = SystemLoginBody.parse(ctx.request.body);

  const user = await SystemUser.findOne({ where: { email: input.email } });
  if (user === null) {
    throw new AuthError('邮箱或密码错误');
  }
  throwIfLocked(user);
  const ok = await verifyPassword(input.password, user.password_hash);
  if (!ok) {
    await recordFailedLogin(user);
    throw new AuthError('邮箱或密码错误');
  }

  await recordSuccessfulLogin(user);
  const token = signToken({ sub: user.id, role: 'system' });
  ctx.body = { token };
});

systemAuthRouter.get('/me', jwtAuth, requireSystemUser, async (ctx) => {
  const u = ctx.state.systemUser as SystemJwtPayload;
  const user = await SystemUser.findOne({ where: { id: u.sub } });
  if (user === null) {
    throw new NotFoundError('系统账号');
  }
  ctx.body = {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    last_login_at: user.last_login_at,
  };
});

systemAuthRouter.post('/change-password', jwtAuth, requireSystemUser, async (ctx) => {
  const u = ctx.state.systemUser as SystemJwtPayload;
  const input = ChangePasswordBody.parse(ctx.request.body);

  const user = await SystemUser.findOne({ where: { id: u.sub } });
  if (user === null) {
    throw new NotFoundError('系统账号');
  }
  const ok = await verifyPassword(input.old_password, user.password_hash);
  if (!ok) {
    throw new AuthError('原密码错误');
  }
  user.password_hash = await hashPassword(input.new_password);
  user.failed_login_count = 0;
  user.locked_until = null;
  await user.save();
  ctx.body = { ok: true };
});
