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
} from '../../lib';

/**
 * systems 子系统：auth 端点只保留 login（/me / change-password 前端未用，已删）
 */
export const systemAuthRouter = new Router({ prefix: '/api/v1/system' });

const SystemLoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
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
