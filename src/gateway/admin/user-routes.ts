import Router from '@koa/router';
import { User, UserMemory } from '../../models';
import { hashPassword } from '../../lib/password';
import { createUserSchema, updateUserSchema } from '../../lib/validators';
import { NotFoundError, ValidationError, type TenantUserJwtPayload } from '../../lib';
import { writeAuditLog } from '../../lib/audit-log';
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
 *
 * ⚠️ **写操作必须留痕**（D5）：建用户 / 改用户 / 删用户都写 audit_logs。
 *    D5 的验收原文是「关键操作（建用户 / 改配置 / 租户启停 / 文档增删）→ audit_logs 有记录」——
 *    建用户这一条以前是漏的，现在补上了。
 *    ⚠️ **密码永远不进 details**（只记「重置过密码」这个事实）。
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

  await writeAuditLog({
    tenant_id: u.tenant_id,
    user_id: u.sub,
    action: 'USER_CREATED',
    resource_type: 'user',
    resource_id: user.id,
    // ⚠️ 密码不进日志
    details: { email: user.email, role: user.role },
    ip: ctx.ip,
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

  // 改之前的邮箱 —— 审计要记「从哪个改成哪个」
  const prevEmail = target.email;

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

  await writeAuditLog({
    tenant_id: u.tenant_id,
    user_id: u.sub,
    action: 'USER_UPDATED',
    resource_type: 'user',
    resource_id: target.id,
    // ⚠️ 密码本身永远不进日志 —— 只记「重置过密码」这个事实
    details: {
      prev_email: prevEmail,
      email: target.email,
      email_changed: target.email !== prevEmail,
      password_reset: input.password !== undefined,
    },
    ip: ctx.ip,
  });

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

  // 删用户要一起删掉他的长期记忆（B4）：
  // 记忆是**物理删除**的，跟用户一起走 —— 留着就成了没人认领的孤儿行
  // （后台「用户记忆」页按 users 表关联，用户没了就再也看不到那些行，
  //  物理删除的合规清理入口也用不上了），而里面可能还留着姓名 / 工号 / 地址。
  await UserMemory.destroy({ where: { tenant_id: u.tenant_id, user_id: id } });

  await writeAuditLog({
    tenant_id: u.tenant_id,
    user_id: u.sub,
    action: 'USER_DELETED',
    resource_type: 'user',
    resource_id: target.id,
    details: { email: target.email, role: target.role },
    ip: ctx.ip,
  });

  await target.destroy();
  ctx.status = 204;
});
