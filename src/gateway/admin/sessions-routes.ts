import Router from '@koa/router';
import { z } from 'zod';
import { Session, Message, User } from '../../models';
import { jwtAuth } from '../jwt-base';
import { requireAdmin } from './middleware';
import { NotFoundError, ValidationError } from '../../lib/errors';
import type { TenantUserJwtPayload } from '../../lib/jwt';

/**
 * admin 端 Session 路由 —— 详见 docs/06 §6.3 + docs/15 §Step 7
 *
 * 路由前缀：/api/v1/admin
 * 鉴权：admin 角色（jwtAuth + requireAdmin）
 *
 * 端点：
 *   GET /sessions                  列本租户所有 session（按时间倒序 + 简单分页）
 *   GET /sessions/:id              单 session 详情（含 messages）
 *
 * 用法：Step 7 验收「后台能看完整 session」+ Step 13 的 P 页面用
 */

export const adminSessionsRouter = new Router({ prefix: '/api/v1/admin' });

adminSessionsRouter.use(jwtAuth, requireAdmin);

// ===== GET /sessions · 列表 =====
// 可选 query：user_id（看某个用户的所有会话）/ status（filter 状态）/ limit / offset
const ListQuery = z.object({
  user_id: z.string().optional(),
  status: z.enum(['active', 'closed', 'transferred']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

adminSessionsRouter.get('/sessions', async (ctx) => {
  const u = ctx.state.adminUser as TenantUserJwtPayload;
  const query = ListQuery.parse(ctx.request.query);

  const where: Record<string, unknown> = { tenant_id: u.tenant_id };
  if (query.user_id !== undefined) where['user_id'] = query.user_id;
  if (query.status !== undefined) where['status'] = query.status;

  const limit = query.limit ?? 50;
  const offset = query.offset ?? 0;

  const { rows, count } = await Session.findAndCountAll({
    where,
    order: [['started_at', 'DESC']],
    limit,
    offset,
    include: [
      // 关联用户（前台 customer 才有 user_id；admin 自己登录时 user_id 可能为 NULL）
      {
        model: User,
        as: 'user',
        attributes: ['id', 'email', 'role'],
        required: false,
      },
    ],
  });

  ctx.body = {
    total: count,
    limit,
    offset,
    sessions: rows.map((s) => ({
      id: s.id,
      channel: s.channel,
      status: s.status,
      title: s.title,
      user: s.user === undefined || s.user === null
        ? null
        : { id: s.user.id, email: s.user.email, role: s.user.role },
      started_at: s.started_at,
      ended_at: s.ended_at,
    })),
  };
});

// ===== GET /sessions/:id · 单 session + 完整 messages =====
// 可选 query：include_messages=false 时不返回消息列表（仅 session 元信息）
adminSessionsRouter.get('/sessions/:id', async (ctx) => {
  const u = ctx.state.adminUser as TenantUserJwtPayload;
  const id = ctx.params.id;
  if (id === undefined || id === '') {
    throw new ValidationError('缺少 session id');
  }

  const includeMessages = ctx.request.query['include_messages'] !== 'false';

  const session = await Session.findOne({
    where: { id, tenant_id: u.tenant_id },
    include: [
      { model: User, as: 'user', attributes: ['id', 'email', 'role'], required: false },
    ],
  });
  if (session === null) {
    throw new NotFoundError('session');
  }

  let messages: Array<{
    id: string;
    role: string;
    content: string | null;
    thinking_content: string | null;
    status: string;
    usage: unknown;
    feedback: number | null;
    feedback_text: string | null;
    created_at: Date;
  }> = [];
  if (includeMessages) {
    const rows = await Message.findAll({
      where: { session_id: id, tenant_id: u.tenant_id },
      order: [['created_at', 'ASC']],
      attributes: [
        'id',
        'role',
        'content',
        'thinking_content',
        'status',
        'usage',
        'feedback',
        'feedback_text',
        'created_at',
      ],
    });
    messages = rows.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      thinking_content: m.thinking_content,
      status: m.status,
      usage: m.usage,
      feedback: m.feedback,
      feedback_text: m.feedback_text,
      created_at: m.created_at,
    }));
  }

  ctx.body = {
    session: {
      id: session.id,
      channel: session.channel,
      status: session.status,
      title: session.title,
      summary: session.summary,
      user: session.user === undefined || session.user === null
        ? null
        : { id: session.user.id, email: session.user.email, role: session.user.role },
      started_at: session.started_at,
      ended_at: session.ended_at,
    },
    messages,
  };
});

