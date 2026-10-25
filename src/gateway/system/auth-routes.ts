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
import { jwtAuth } from '../jwt-base';
import { requireSystemUser } from './middleware';
import { changePasswordFor } from '../../services/change-password';
import { changePasswordSchema } from '../../lib/validators';
import { writeAuditLog } from '../../lib/audit-log';
import type { SystemJwtPayload } from '../../lib/jwt';

/**
 * system 子系统：login / me / change-password 三件套
 *
 * 路由（都挂在 /api/v1/system 下）：
 *   POST /login           {email, password} → { token, user }
 *   GET  /me                              → { user }
 *   POST /change-password {old_password, new_password}
 *
 * ⚠️ `/me` 和 `/change-password` 之前被删过（注释写着「前端未用」）。
 *
 * 💡 **system 用户没有 `must_change_password` 字段**（`users` 表有，`system_users` 表没有）——
 *    平台方账号由平台自己管理，没有「被临时重置密码」这个场景。
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
  ctx.body = {
    token,
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
    },
  };
});

/** 当前登录者是谁 */
systemAuthRouter.get('/me', jwtAuth, requireSystemUser, async (ctx) => {
  const u = ctx.state.systemUser as SystemJwtPayload;
  const user = await SystemUser.findByPk(u.sub);
  if (user === null) {
    throw new AuthError('账号不存在或已被删除');
  }
  ctx.body = {
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
      last_login_at: user.last_login_at?.toISOString() ?? null,
    },
  };
});

/** 自己改密码 */
systemAuthRouter.post('/change-password', jwtAuth, requireSystemUser, async (ctx) => {
  const u = ctx.state.systemUser as SystemJwtPayload;
  const input = changePasswordSchema.parse(ctx.request.body);

  const user = await SystemUser.findByPk(u.sub);
  if (user === null) {
    throw new AuthError('账号不存在或已被删除');
  }

  await changePasswordFor(user, input.old_password, input.new_password);

  await writeAuditLog({
    // system 子系统的日志是系统级的 —— tenant_id 为 NULL
    tenant_id: null,
    user_id: user.id,
    action: 'PASSWORD_CHANGED',
    resource_type: 'system_user',
    resource_id: user.id,
    details: { self_service: true },
    ip: ctx.ip,
  });

  // 换一枚新 token（system 用户没有 must_change_password 标志，
  // 但统一返回，前端处理方式一致）
  const token = signToken({ sub: user.id, role: 'system' });
  ctx.body = { ok: true, token };
});
