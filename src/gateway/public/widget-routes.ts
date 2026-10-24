import Router from '@koa/router';
import type { Context } from 'koa';
import { pipeUIMessageStreamToResponse } from 'ai';
import { config } from '../../config';
import { Session, Tenant } from '../../models';
import { AppError, NotFoundError } from '../../lib/errors';
import { logger } from '../../logger';
import {
  loadSessionUiMessages,
  parseChatRequest,
  type ChatRequestBody,
} from '../../services/chat';
import { runChatTurn } from '../customer';
import { signWidgetToken, verifyWidgetToken } from './widget-token';

/**
 * 公开聊天挂件 —— E1（docs/12-e-需求-业务接入与平台运营.md §E1）
 *
 * 路由前缀：/api/v1/public/widget/:tenantCode
 * 鉴权：**无登录**。租户靠 URL 里的 tenant code 定位；会话靠匿名 token 认领
 *      （token 的形态和归属规则见 ./widget-token.ts）。
 *
 * 端点：
 *   GET  /:tenantCode/info        租户基本信息（页头显示公司名；不建会话）
 *   POST /:tenantCode/sessions     新建匿名会话 → 返回 session_id + token
 *   GET  /:tenantCode/session      凭 token 恢复会话 + 历史消息
 *   POST /:tenantCode/messages     ★ 流式发消息（SSE），凭 token 认领会话
 *
 * 会话落库：sessions.channel = 'widget'，sessions.user_id = NULL
 *   —— 这两列本来就为挂件预留好了（见 src/models/Session.ts）。
 *   user_id 为 NULL 意味着「匿名」，也因此**不注入用户长期记忆**（B4 的记忆是按用户 id 存的）。
 *
 * ⚠️ 限流维度用 `widget:<会话 id>`（不是用户 id —— 匿名用户没有用户 id）：
 *    同一个会话反复刷会被限住；换浏览器（换会话 id）就换了一个额度。
 *    这是匿名场景下的固有取舍：限流挡不住「一个人开十个浏览器」。
 */

export const publicWidgetRouter = new Router({ prefix: '/api/v1/public/widget' });

/** 请求头里带匿名 token 的名字（前端也用这个名字发） */
export const WIDGET_TOKEN_HEADER = 'x-widget-token';

/**
 * 按 tenant code 找租户，并过一遍 F2 的启停 / 到期闸门。
 *
 * 挂件是公开页面，所以这里**不**复用 assertTenantAccessible（它抛的是
 * 「邮箱或密码错误」，那是登录页的文案）。挂件用 403 + 一句人话，
 * 让访客知道「这个客服现在不提供服务」，而不是看到一个 404。
 */
async function resolveTenant(ctx: Context): Promise<Tenant> {
  const code = ctx.params.tenantCode ?? '';
  const tenant = await Tenant.findOne({ where: { code } });
  if (tenant === null) {
    throw new NotFoundError('租户');
  }
  const now = Date.now();
  if (
    tenant.status === 'disabled' ||
    (tenant.expires_at !== null && tenant.expires_at.getTime() <= now)
  ) {
    throw new AppError('该客服暂未提供服务', 'TENANT_UNAVAILABLE', 403);
  }
  return tenant;
}

/**
 * 凭 token 找回会话。
 *
 * 四个条件缺一不可：id 匹配、租户一致、**user_id 为空**（只认匿名会话）、
 * channel 是 widget（不认 customer 前台的会话，也不认对外 API 的会话）。
 * 任何一条不满足都按「不存在」处理，不告诉调用方到底哪里不对。
 */
async function resolveSession(ctx: Context, tenant: Tenant): Promise<Session> {
  const token = ctx.get(WIDGET_TOKEN_HEADER);
  const sessionId = verifyWidgetToken(token);
  if (sessionId === null) {
    throw new NotFoundError('会话');
  }
  const session = await Session.findOne({
    where: {
      id: sessionId,
      tenant_id: tenant.id,
      user_id: null,
      channel: 'widget',
    },
  });
  if (session === null) {
    throw new NotFoundError('会话');
  }
  return session;
}

// ===== 租户信息 =====

publicWidgetRouter.get('/:tenantCode/info', async (ctx) => {
  const tenant = await resolveTenant(ctx);
  ctx.body = {
    tenant_code: tenant.code,
    tenant_name: tenant.name,
  };
});

// ===== 新建匿名会话 =====

publicWidgetRouter.post('/:tenantCode/sessions', async (ctx) => {
  const tenant = await resolveTenant(ctx);

  const session = await Session.create({
    tenant_id: tenant.id,
    // 匿名：没有用户
    user_id: null,
    channel: 'widget',
    status: 'active',
    title: null,
    started_at: new Date(),
    metadata: {
      client: ctx.get('user-agent').slice(0, 200),
    },
  });

  ctx.status = 201;
  ctx.body = {
    session_id: session.id,
    token: signWidgetToken(session.id),
    tenant_name: tenant.name,
    started_at: session.started_at.toISOString(),
  };
});

// ===== 恢复会话（关掉浏览器再打开 → 历史还在）=====

publicWidgetRouter.get('/:tenantCode/session', async (ctx) => {
  const tenant = await resolveTenant(ctx);
  const session = await resolveSession(ctx, tenant);
  const { messages } = await loadSessionUiMessages(session.id, 200);
  ctx.body = {
    session_id: session.id,
    token: signWidgetToken(session.id),
    tenant_name: tenant.name,
    title: session.title,
    messages,
  };
});

// ===== ★ 流式发消息 =====

publicWidgetRouter.post('/:tenantCode/messages', async (ctx) => {
  const tenant = await resolveTenant(ctx);
  const session = await resolveSession(ctx, tenant);

  // 跑一轮对话（限流 / 预算 / 审核 / 落库 / 历史 / 提示词，全在开流之前）
  const turn = await runChatTurn({
    ctx,
    session,
    tenant,
    parseBody: (maxInputChars) =>
      parseChatRequest(ctx.request.body as ChatRequestBody, maxInputChars),
    rateLimitScope: `widget:${session.id}`,
    traceName: 'widget.message',
    traceKind: 'chat',
  });

  ctx.respond = false;
  await pipeUIMessageStreamToResponse({
    response: ctx.res,
    status: 200,
    stream: turn.stream,
    ...(config.CHAT.KEEPALIVE_MS > 0 ? { keepAliveMs: config.CHAT.KEEPALIVE_MS } : {}),
  });
});
