import Router from '@koa/router';
import type { Context } from 'koa';
import { z } from 'zod';
import { jwtAuth } from '../jwt-base';
import { requireCustomer } from './middleware';
import { NotFoundError } from '../../lib/errors';
import type { TenantUserJwtPayload } from '../../lib/jwt';
import { writeAuditLog } from '../../lib/audit-log';
import {
  createMemory,
  deleteAllMemoriesPermanently,
  deleteOwnedMemoryPermanently,
  getOwnedMemory,
  isMemoryEnabledFor,
  listUserMemories,
  setMemoryEnabledFor,
  setMemoryStatus,
  updateMemoryContent,
} from '../../services/memory';
import { USER_MEMORY_CATEGORIES, type UserMemoryCategory } from '../../models';

/**
 * customer 子系统：用户自己的长期记忆 —— B4（docs/12-b-需求-ai对话能力.md §B4）
 *
 * 路由前缀：/api/v1/customer　鉴权：customer 角色（jwtAuth + requireCustomer）
 *
 * 端点：
 *   GET    /memories              我的记忆列表（默认只给生效中的）
 *   POST   /memories              我自己新增一条
 *   PATCH  /memories/:id          我编辑一条（只能改自己的）
 *   DELETE /memories/:id          我删一条（归档，可恢复）
 *   POST   /memories/:id/restore  恢复归档的
 *   DELETE /memories/:id/permanent 我彻底删一条（不可恢复）
 *   GET    /memories/settings     我的记忆开关
 *   PUT    /memories/settings     改我的记忆开关
 *   DELETE /memories              清空我的全部记忆（归档，可恢复）
 *   DELETE /memories/permanent    彻底删掉我的全部记忆（不可恢复）
 *
 * ## 归属判定
 * 一律按 (id, tenant_id, user_id) 三元组查 —— 别人的记忆按「不存在」处理（404），
 * 不泄露这个 id 是否存在。这跟会话的归属校验是同一套逻辑。
 *
 * ## 「我的记忆」里的写操作，source 一律记成 'user'
 * 自动抽取（source='auto'）不许改、不许归档用户自己写的记忆 ——
 * 用户明确写下的东西比模型猜的更权威。管理员写的（source='admin'）用户可以改。
 *
 * ## 路由顺序（别调换）
 * `/memories/permanent` 必须排在 `/memories/:id` **前面** ——
 * 否则 "permanent" 会被当成 id 匹配掉（Koa 按注册顺序匹配，先匹配上的赢）。
 */

export const customerMemoryRouter = new Router({ prefix: '/api/v1/customer' });

customerMemoryRouter.use(jwtAuth, requireCustomer);

const listQuerySchema = z.object({
  /** active = 只看生效中的；archived = 只看归档的；all = 都要 */
  status: z.enum(['active', 'archived', 'all']).default('active'),
  category: z.enum(USER_MEMORY_CATEGORIES).optional(),
});

const createBodySchema = z.object({
  content: z.string().trim().min(1, '记忆内容不能为空').max(500),
  // 用户自己写的记忆多半是偏好（「回答请简短」）而不是事实
  category: z.enum(USER_MEMORY_CATEGORIES).default('preference'),
});

const updateBodySchema = z
  .object({
    content: z.string().trim().min(1, '记忆内容不能为空').max(500).optional(),
    category: z.enum(USER_MEMORY_CATEGORIES).optional(),
  })
  .refine((v) => v.content !== undefined || v.category !== undefined, {
    message: '至少要改一个字段',
  });

const settingsBodySchema = z.object({
  memory_enabled: z.boolean(),
});

/** 取当前 customer —— 中间件已经保证一定存在且是 customer 角色 */
function currentUser(ctx: Context): TenantUserJwtPayload {
  return ctx.state.customerUser as TenantUserJwtPayload;
}

// ===== 列表 =====

customerMemoryRouter.get('/memories', async (ctx) => {
  const u = currentUser(ctx);
  const input = listQuerySchema.parse(ctx.query);

  const memories = await listUserMemories(u.tenant_id, u.sub, {
    // ⚠️ 'all' 要原样传下去 —— 折成 undefined 会被当成「只查生效中」
    status: input.status,
    ...(input.category === undefined ? {} : { category: input.category }),
  });

  ctx.body = {
    memories,
    total: memories.length,
    memory_enabled: await isMemoryEnabledFor(u.tenant_id, u.sub),
  };
});

// ===== 新增 / 编辑 / 删除 =====

customerMemoryRouter.post('/memories', async (ctx) => {
  const u = currentUser(ctx);
  const input = createBodySchema.parse(ctx.request.body ?? {});

  const row = await createMemory({
    tenantId: u.tenant_id,
    userId: u.sub,
    content: input.content,
    category: input.category as UserMemoryCategory,
    // 用户自己写的 = 100% 置信度，而且自动抽取不许动它
    source: 'user',
  });

  await writeAuditLog({
    tenant_id: u.tenant_id,
    user_id: u.sub,
    action: 'USER_MEMORY_CREATED',
    resource_type: 'user_memory',
    resource_id: row.id,
    details: { content: row.content, category: row.category, source: 'user' },
    ip: ctx.ip,
  });

  ctx.status = 201;
  ctx.body = { id: row.id, content: row.content, category: row.category, source: row.source };
});

customerMemoryRouter.patch('/memories/:id', async (ctx) => {
  const u = currentUser(ctx);
  const input = updateBodySchema.parse(ctx.request.body ?? {});

  const row = await getOwnedMemory(u.tenant_id, u.sub, ctx.params.id ?? '');
  if (row === null) {
    throw new NotFoundError('记忆');
  }

  // ⚠️ 用 updateMemoryContent 的返回值，不要用上面那个 row ——
  //    service 内部重新加载并保存了这条记录，外面的 row 还是旧值
  const updated = await updateMemoryContent(u.tenant_id, row.id, {
    ...(input.content === undefined ? {} : { content: input.content }),
    ...(input.category === undefined ? {} : { category: input.category }),
    // 用户改过 = 用户为这条内容背书 → 变成 source='user'，
    // 自动抽取从此不许再改它、不许归档它（否则用户刚纠正的又能被模型改回去）
    source: 'user',
  });

  await writeAuditLog({
    tenant_id: u.tenant_id,
    user_id: u.sub,
    action: 'USER_MEMORY_UPDATED',
    resource_type: 'user_memory',
    resource_id: row.id,
    details: { content: input.content ?? null, category: input.category ?? null },
    ip: ctx.ip,
  });

  ctx.body = { id: updated.id, content: updated.content, category: updated.category };
});

// ===== 彻底删除（物理删，不可恢复）=====
//
// ⚠️ 排在 `/memories/:id` **前面**：Koa 按注册顺序匹配，
//    "/memories/permanent" 晚注册会被 ":id" 抢走（id = "permanent"）。
customerMemoryRouter.delete('/memories/permanent', async (ctx) => {
  const u = currentUser(ctx);

  const deleted = await deleteAllMemoriesPermanently(u.tenant_id, u.sub);

  await writeAuditLog({
    tenant_id: u.tenant_id,
    user_id: u.sub,
    action: 'USER_MEMORY_PURGED',
    resource_type: 'user_memory',
    details: { count: deleted, permanent: true, by: 'user' },
    ip: ctx.ip,
  });

  ctx.status = 204;
});

customerMemoryRouter.delete('/memories/:id/permanent', async (ctx) => {
  const u = currentUser(ctx);

  // 归属判定在 service 里（不存在就 404，不泄露 id 是否存在）
  const row = await deleteOwnedMemoryPermanently(u.tenant_id, u.sub, ctx.params.id ?? '');

  await writeAuditLog({
    tenant_id: u.tenant_id,
    user_id: u.sub,
    action: 'USER_MEMORY_PURGED',
    resource_type: 'user_memory',
    resource_id: row.id,
    details: { content: row.content, permanent: true, by: 'user' },
    ip: ctx.ip,
  });

  ctx.status = 204;
});

customerMemoryRouter.delete('/memories/:id', async (ctx) => {
  const u = currentUser(ctx);

  const row = await getOwnedMemory(u.tenant_id, u.sub, ctx.params.id ?? '');
  if (row === null) {
    throw new NotFoundError('记忆');
  }

  // 归档而不是物理删 —— 误删了还能从「已归档」里恢复回来
  await setMemoryStatus(u.tenant_id, row.id, 'archived');

  await writeAuditLog({
    tenant_id: u.tenant_id,
    user_id: u.sub,
    action: 'USER_MEMORY_ARCHIVED',
    resource_type: 'user_memory',
    resource_id: row.id,
    details: { content: row.content },
    ip: ctx.ip,
  });

  ctx.status = 204;
});

customerMemoryRouter.post('/memories/:id/restore', async (ctx) => {
  const u = currentUser(ctx);

  const row = await getOwnedMemory(u.tenant_id, u.sub, ctx.params.id ?? '');
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
    details: { content: row.content },
    ip: ctx.ip,
  });

  ctx.body = { id: row.id, status: 'active' };
});

// ===== 设置 =====

customerMemoryRouter.get('/memories/settings', async (ctx) => {
  const u = currentUser(ctx);
  ctx.body = { memory_enabled: await isMemoryEnabledFor(u.tenant_id, u.sub) };
});

customerMemoryRouter.put('/memories/settings', async (ctx) => {
  const u = currentUser(ctx);
  const input = settingsBodySchema.parse(ctx.request.body ?? {});

  await setMemoryEnabledFor(u.tenant_id, u.sub, input.memory_enabled);

  await writeAuditLog({
    tenant_id: u.tenant_id,
    user_id: u.sub,
    action: 'USER_MEMORY_TOGGLED',
    resource_type: 'user_memory',
    details: { memory_enabled: input.memory_enabled },
    ip: ctx.ip,
  });

  ctx.body = { memory_enabled: input.memory_enabled };
});

// ===== 清空全部 =====

customerMemoryRouter.delete('/memories', async (ctx) => {
  const u = currentUser(ctx);

  const rows = await listUserMemories(u.tenant_id, u.sub, { status: 'active' });
  if (rows.length === 0) {
    ctx.status = 204;
    return;
  }

  for (const row of rows) {
    try {
      await setMemoryStatus(u.tenant_id, row.id, 'archived');
    } catch {
      // 单条失败不阻断整体清空
    }
  }

  await writeAuditLog({
    tenant_id: u.tenant_id,
    user_id: u.sub,
    action: 'USER_MEMORY_CLEARED',
    resource_type: 'user_memory',
    details: { count: rows.length },
    ip: ctx.ip,
  });

  ctx.status = 204;
});
