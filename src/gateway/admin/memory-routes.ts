import Router from '@koa/router';
import type { Context } from 'koa';
import { z } from 'zod';
import { jwtAuth } from '../jwt-base';
import { requireAdmin } from './middleware';
import { NotFoundError } from '../../lib/errors';
import type { TenantUserJwtPayload } from '../../lib/jwt';
import { writeAuditLog } from '../../lib/audit-log';
import {
  createMemory,
  deleteMemoryPermanently,
  getMemoryById,
  listMemoryOwners,
  listTenantMemories,
  setMemoryStatus,
  updateMemoryContent,
} from '../../services/memory';
import { User, USER_MEMORY_CATEGORIES, USER_MEMORY_SOURCES } from '../../models';

/**
 * admin 子系统：租户后台的「用户记忆」端点 —— B4（docs/12-b-需求-ai对话能力.md §B4）
 *
 * 路由前缀：/api/v1/admin　鉴权：admin 角色（jwtAuth + requireAdmin）
 *
 * 端点：
 *   GET    /memories              本租户全部用户的记忆（分页 + 筛选）
 *   GET    /memories/owners       哪些用户有记忆、各有多少条
 *   GET    /memories/:id          单条详情
 *   PATCH  /memories/:id          管理员改内容 / 分类
 *   DELETE /memories/:id          归档（软删）
 *   POST   /memories/:id/restore  恢复归档的
 *   DELETE /memories/:id/permanent 物理删除（合规清理用，不可恢复）
 *
 * ## 跨租户隔离
 * 所有查询强制带 `tenant_id`（从 JWT 取）—— 这个表没有 Sequelize scope，
 * 写查询时自己带条件。
 *
 * ## 路由顺序
 * `/memories/owners` 必须排在 `/memories/:id` 前面 ——
 * 否则 "owners" 会被当成 id 匹配掉。
 */

export const adminMemoryRouter = new Router({ prefix: '/api/v1/admin' });

adminMemoryRouter.use(jwtAuth, requireAdmin);

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
  /** 按用户筛（配合「用户记忆」页左侧的用户列表） */
  user_id: z.string().trim().max(64).optional(),
  category: z.enum(USER_MEMORY_CATEGORIES).optional(),
  source: z.enum(USER_MEMORY_SOURCES).optional(),
  /** 默认 active；archived 能看到被归档的；all 全要 */
  status: z.enum(['active', 'archived', 'all']).default('active'),
  /** 内容关键词 */
  keyword: z.string().trim().max(200).optional(),
});

const updateBodySchema = z
  .object({
    content: z.string().trim().min(1, '记忆内容不能为空').max(500).optional(),
    category: z.enum(USER_MEMORY_CATEGORIES).optional(),
  })
  .refine((v) => v.content !== undefined || v.category !== undefined, {
    message: '至少要改一个字段',
  });

const createBodySchema = z.object({
  /** 给谁加（必须是本租户的用户） */
  user_id: z.string().trim().min(1, '必须指定用户'),
  content: z.string().trim().min(1, '记忆内容不能为空').max(500),
  category: z.enum(USER_MEMORY_CATEGORIES).default('fact'),
});

/** 取当前 admin —— 中间件已经保证一定存在且是 admin 角色 */
function currentUser(ctx: Context): TenantUserJwtPayload {
  return ctx.state.adminUser as TenantUserJwtPayload;
}

// ===== 列表 =====

adminMemoryRouter.get('/memories', async (ctx) => {
  const u = currentUser(ctx);
  const input = listQuerySchema.parse(ctx.query);

  const result = await listTenantMemories(
    u.tenant_id,
    {
      userId: input.user_id,
      category: input.category,
      source: input.source,
      // ⚠️ 'all' 要原样传下去 —— 折成 undefined 会被当成「只查生效中」
      status: input.status,
      keyword: input.keyword,
    },
    input.page,
    input.page_size,
  );

  ctx.body = result;
});

// ⚠️ 必须排在 /memories/:id 前面
adminMemoryRouter.get('/memories/owners', async (ctx) => {
  const u = currentUser(ctx);
  ctx.body = { owners: await listMemoryOwners(u.tenant_id) };
});

// ===== 单条 =====

adminMemoryRouter.get('/memories/:id', async (ctx) => {
  const u = currentUser(ctx);
  const row = await getMemoryById(u.tenant_id, ctx.params.id ?? '');
  if (row === null) {
    throw new NotFoundError('记忆');
  }
  ctx.body = row.toJSON();
});

// ===== 改 / 归档 / 恢复 / 物理删 =====

/**
 * 管理员给某个用户加一条记忆（source='admin'）。
 *
 * 典型场景：客服接到电话后给客户打标（「这个客户只关心物流时效」）。
 * 自动抽取抓不到这种线下才知道的信息，但管理员能写。
 *
 * ⚠️ 用户自己写的记忆（source='user'）自动抽取不许动 ——
 *    但**管理员可以**。管理员的话比模型的话权威。
 */
adminMemoryRouter.post('/memories', async (ctx) => {
  const u = currentUser(ctx);
  const input = createBodySchema.parse(ctx.request.body ?? {});

  // 归属校验：只能给本租户的用户加记忆
  const target = await User.findOne({
    where: { id: input.user_id, tenant_id: u.tenant_id },
    attributes: ['id'],
  });
  if (target === null) {
    throw new NotFoundError('用户');
  }

  const row = await createMemory({
    tenantId: u.tenant_id,
    userId: input.user_id,
    content: input.content,
    category: input.category,
    source: 'admin',
  });

  await writeAuditLog({
    tenant_id: u.tenant_id,
    user_id: u.sub,
    action: 'USER_MEMORY_CREATED',
    resource_type: 'user_memory',
    resource_id: row.id,
    details: { target_user_id: input.user_id, content: row.content, category: row.category, by: 'admin' },
    ip: ctx.ip,
  });

  ctx.status = 201;
  ctx.body = { id: row.id, content: row.content, category: row.category, source: row.source };
});

adminMemoryRouter.patch('/memories/:id', async (ctx) => {
  const u = currentUser(ctx);
  const input = updateBodySchema.parse(ctx.request.body ?? {});

  const row = await getMemoryById(u.tenant_id, ctx.params.id ?? '');
  if (row === null) {
    throw new NotFoundError('记忆');
  }

  // ⚠️ 用 updateMemoryContent 的返回值，不要用上面那个 row ——
  //    service 内部重新加载并保存了这条记录，外面的 row 还是旧值
  const updated = await updateMemoryContent(u.tenant_id, row.id, {
    ...(input.content === undefined ? {} : { content: input.content }),
    ...(input.category === undefined ? {} : { category: input.category }),
    // 管理员改过 = 管理员为这条内容背书 → source='admin'，
    // 自动抽取同样不许再动它（source 只有 'auto' 的能被模型改写/归档）
    source: 'admin',
  });

  await writeAuditLog({
    tenant_id: u.tenant_id,
    user_id: u.sub,
    action: 'USER_MEMORY_UPDATED',
    resource_type: 'user_memory',
    resource_id: row.id,
    details: {
      target_user_id: row.user_id,
      content: input.content ?? null,
      category: input.category ?? null,
      by: 'admin',
    },
    ip: ctx.ip,
  });

  ctx.body = { id: updated.id, content: updated.content, category: updated.category };
});

adminMemoryRouter.delete('/memories/:id', async (ctx) => {
  const u = currentUser(ctx);

  const row = await getMemoryById(u.tenant_id, ctx.params.id ?? '');
  if (row === null) {
    throw new NotFoundError('记忆');
  }

  await setMemoryStatus(u.tenant_id, row.id, 'archived');

  await writeAuditLog({
    tenant_id: u.tenant_id,
    user_id: u.sub,
    action: 'USER_MEMORY_ARCHIVED',
    resource_type: 'user_memory',
    resource_id: row.id,
    details: { target_user_id: row.user_id, content: row.content, by: 'admin' },
    ip: ctx.ip,
  });

  ctx.status = 204;
});

adminMemoryRouter.post('/memories/:id/restore', async (ctx) => {
  const u = currentUser(ctx);

  const row = await getMemoryById(u.tenant_id, ctx.params.id ?? '');
  if (row === null) {
    throw new NotFoundError('记忆');
  }

  await setMemoryStatus(u.tenant_id, row.id, 'active');

  await writeAuditLog({
    tenant_id: u.tenant_id,
    user_id: u.sub,
    action: 'USER_MEMORY_RESTORED',
    resource_type: 'user_memory',
    resource_id: row.id,
    details: { target_user_id: row.user_id, by: 'admin' },
    ip: ctx.ip,
  });

  ctx.body = { id: row.id, status: 'active' };
});

adminMemoryRouter.delete('/memories/:id/permanent', async (ctx) => {
  const u = currentUser(ctx);

  const row = await getMemoryById(u.tenant_id, ctx.params.id ?? '');
  if (row === null) {
    throw new NotFoundError('记忆');
  }

  await deleteMemoryPermanently(u.tenant_id, row.id);

  await writeAuditLog({
    tenant_id: u.tenant_id,
    user_id: u.sub,
    action: 'USER_MEMORY_PURGED',
    resource_type: 'user_memory',
    resource_id: row.id,
    details: { target_user_id: row.user_id, content: row.content, permanent: true, by: 'admin' },
    ip: ctx.ip,
  });

  ctx.status = 204;
});
