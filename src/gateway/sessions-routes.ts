import Router from '@koa/router';
import { apiKeyAuth, type ApiContext } from './api-key-auth';
import { Session, Message } from '../models';
import { NotFoundError } from '../lib/errors';

/**
 * 对外 Session 路由（API Key 鉴权）—— 详见 docs/06 §6.2 + docs/15 §Step 7
 *
 * 路由前缀：/api/v1
 * 鉴权：apiKeyAuth
 *
 * 端点：
 *   GET /sessions/:id    拿一个 session + 完整消息列表（widget 端刷新页面恢复历史用）
 *
 * 返回字段：
 *   {
 *     session: { id, channel, status, title, summary, started_at, ended_at },
 *     messages: [{ id, role, content, thinking_content, status, usage, created_at, feedback }]
 *   }
 */

export const sessionsRouter = new Router({ prefix: '/api/v1' });

sessionsRouter.use(apiKeyAuth);

sessionsRouter.get('/sessions/:id', async (ctx) => {
  const api = ctx.state.apiContext as ApiContext;
  const id = ctx.params.id;
  if (id === undefined || id === '') {
    throw new NotFoundError('session');
  }

  const session = await Session.findOne({
    where: { id, tenant_id: api.tenantId },
  });
  if (session === null) {
    throw new NotFoundError('session');
  }

  const messages = await Message.findAll({
    where: { session_id: id, tenant_id: api.tenantId },
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

  ctx.body = {
    session: {
      id: session.id,
      channel: session.channel,
      status: session.status,
      title: session.title,
      summary: session.summary,
      started_at: session.started_at,
      ended_at: session.ended_at,
    },
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      thinking_content: m.thinking_content,
      status: m.status,
      usage: m.usage,
      feedback: m.feedback,
      feedback_text: m.feedback_text,
      created_at: m.created_at,
    })),
  };
});
