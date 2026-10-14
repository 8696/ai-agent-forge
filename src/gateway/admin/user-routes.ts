import Router from '@koa/router';
import { User } from '../../models';
import { hashPassword } from '../../lib/password';
import { createUserSchema, updateUserSchema } from '../../lib/validators';
import { NotFoundError, ValidationError, type TenantUserJwtPayload } from '../../lib';
import { jwtAuth } from '../jwt-base';
import { requireAdmin } from './middleware';

/**
 * admin 子系统：租户用户管理端点 —— 详见 docs/16-需求技术对照表 A3
 *
 * 路由（全部要求 admin 角色）：
 *   GET    /api/admin/users
 *   POST   /api/admin/users
 *   PATCH  /api/admin/users/:id
 *   DELETE /api/admin/users/:id
 *
 * 跨租户隔离：ctx.state.adminUser.tenant_id 自动加 where filter
 */
export const adminUserRouter = new Router({ prefix: '/api/v1/admin' });

adminUserRouter.use(jwtAuth, requireAdmin);

// 列当前租户用户
adminUserRouter.get('/users', async (ctx) => {
  const u = ctx.state.adminUser as TenantUserJwtPayload;
  const users = await User.findAll({
    where: { tenant_id: u.tenant_id },
    attributes: ['id', 'email', 'role', 'must_change_password', 'last_login_at', 'created_at'],
    order: [['created_at', 'DESC']],
  });
  ctx.body = { users: users.map((x) => x.toJSON()) };
});

// 创建后台 / 前台用户
adminUserRouter.post('/users', async (ctx) => {
  const u = ctx.state.adminUser as TenantUserJwtPayload;
  const input = createUserSchema.parse(ctx.request.body);

  const exists = await User.findOne({ where: { email: input.email, tenant_id: u.tenant_id } });
  if (exists !== null) {
    throw new ValidationError('邮箱已存在');
  }

  const user = await User.create({
    tenant_id: u.tenant_id,
    email: input.email,
    password_hash: await hashPassword(input.password),
    role: input.role,
  });

  ctx.status = 201;
  ctx.body = {
    id: user.id,
    email: user.email,
    role: user.role,
    must_change_password: user.must_change_password,
  };
});

// 改邮箱 / 重置密码
adminUserRouter.patch('/users/:id', async (ctx) => {
  const u = ctx.state.adminUser as TenantUserJwtPayload;
  const id = ctx.params.id;
  const input = updateUserSchema.parse(ctx.request.body);

  const target = await User.findOne({ where: { id, tenant_id: u.tenant_id } });
  if (target === null) {
    throw new NotFoundError('用户');
  }

  if (input.email !== undefined && input.email !== target.email) {
    const dup = await User.findOne({ where: { email: input.email, tenant_id: u.tenant_id } });
    if (dup !== null) {
      throw new ValidationError('邮箱已存在');
    }
    target.email = input.email;
  }
  if (input.password !== undefined) {
    target.password_hash = await hashPassword(input.password);
    target.must_change_password = false;
  }
  await target.save();

  ctx.body = {
    id: target.id,
    email: target.email,
    role: target.role,
    must_change_password: target.must_change_password,
  };
});

// 软删除：项目小，先硬删除（Step 13 之后可改软删）
adminUserRouter.delete('/users/:id', async (ctx) => {
  const u = ctx.state.adminUser as TenantUserJwtPayload;
  const id = ctx.params.id;

  if (id === u.sub) {
    throw new ValidationError('不能删除自己');
  }

  const target = await User.findOne({ where: { id, tenant_id: u.tenant_id } });
  if (target === null) {
    throw new NotFoundError('用户');
  }
  await target.destroy();
  ctx.status = 204;
});
