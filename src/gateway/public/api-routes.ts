import Router from '@koa/router';
import type { Context } from 'koa';
import { z } from 'zod';
import { pipeUIMessageStreamToResponse } from 'ai';
import { config } from '../../config';
import { Session, Tenant } from '../../models';
import { AppError, NotFoundError, ValidationError } from '../../lib/errors';
import { apiKeyAuth, type ApiKeyPrincipal } from '../../lib/api-key-auth';
import { runChatTurn } from '../customer';

/**
 * 对外 REST API —— E1（docs/12-e-需求-业务接入与平台运营.md §E1）
 *
 * 路由前缀：/api/v1/public
 * 鉴权：**API Key**（Authorization: Bearer ak_xxx / X-API-Key: ak_xxx）
 *
 * ⚠️ 跟 system / admin / customer 三个子系统**并列但完全独立**：
 *    这里不认 JWT，也不发 JWT。API Key 只属于某一个租户，
 *    它能访问什么完全由「这把 key 属于哪个租户」决定。
 *
 * 端点：
 *   POST /chat         ★ 提问（一次性 JSON 回答）
 *   POST /chat/stream  ★ 提问（SSE 流式）
 *
 * 两条端点复用跟 customer 前台**完全相同**的 RAG + LLM 链路
 * （runChatTurn，见 src/gateway/customer/chat-routes.ts）：
 * 同一个检索器、同一套提示词、同一套预算 / 限流 / 审核 / 记账 / 观测。
 *
 * 会话落库：sessions.channel = 'api'，sessions.user_id = NULL
 *   —— 「api」本来就是 SessionChannel 里预留的值（见 src/models/Session.ts）。
 *   多轮对话靠请求体里的 session_id 串起来；不传就每次新开一段。
 *
 * 限流维度：`apikey:<key id>` —— 一把 key 一个额度，跟租户额度叠加生效。
 */

export const publicApiRouter = new Router({ prefix: '/api/v1/public' });

publicApiRouter.use(apiKeyAuth);

const askBodySchema = z.object({
  /** 本轮要问什么 */
  question: z.string().trim().min(1, 'question 不能为空'),
  /**
   * 续哪一段对话。**不传就新开一段**。
   * 必须是这把 key 所属租户下的 channel='api' 会话，否则 404。
   */
  session_id: z.string().trim().min(1).max(64).optional(),
});

/** 从 ctx.state 里取鉴权结果（apiKeyAuth 已经保证一定存在） */
function currentApiKey(ctx: Context): ApiKeyPrincipal {
  return ctx.state.apiKey as ApiKeyPrincipal;
}

/** key 所属的租户 —— 外部系统能访问什么完全由它决定 */
async function resolveTenant(ctx: Context, principal: ApiKeyPrincipal): Promise<Tenant> {
  const tenant = await Tenant.findByPk(principal.tenantId);
  if (tenant === null) {
    throw new NotFoundError('租户');
  }
  const now = Date.now();
  if (
    tenant.status === 'disabled' ||
    (tenant.expires_at !== null && tenant.expires_at.getTime() <= now)
  ) {
    throw new AppError('该租户的服务已暂停', 'TENANT_UNAVAILABLE', 403);
  }
  return tenant;
}

/**
 * 取会话：给了 session_id 就续上（必须属于本租户且 channel='api'），
 * 没给就新开一段。
 */
async function resolveOrCreateSession(
  ctx: Context,
  tenant: Tenant,
  sessionId: string | undefined,
): Promise<Session> {
  if (sessionId !== undefined) {
    const session = await Session.findOne({
      where: {
        id: sessionId,
        tenant_id: tenant.id,
        user_id: null,
        channel: 'api',
      },
    });
    if (session === null) {
      throw new NotFoundError('会话');
    }
    return session;
  }
  return Session.create({
    tenant_id: tenant.id,
    user_id: null,
    channel: 'api',
    status: 'active',
    title: null,
    started_at: new Date(),
    metadata: { client: ctx.get('user-agent').slice(0, 200) },
  });
}

/** 把「这轮问什么」转成服务层认的形状，并按租户侧的字数上限校验 */
function parseQuestion(question: string, maxInputChars: number): {
  userText: string;
  isRegenerate: false;
  regenerateTargetId: null;
} {
  const trimmed = question.trim();
  if (trimmed === '') {
    throw new ValidationError('question 不能为空');
  }
  if (trimmed.length > maxInputChars) {
    throw new ValidationError(`question 超过 ${maxInputChars} 字`);
  }
  return { userText: trimmed, isRegenerate: false, regenerateTargetId: null };
}

/** 流里的 chunk（线上就是 JSON 对象，这里只取用得到的几个字段） */
interface RawChunk {
  type: string;
  delta?: string;
  data?: unknown;
  errorText?: string;
}

function asChunk(value: unknown): RawChunk | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const type = (value as { type?: unknown }).type;
  if (typeof type !== 'string') {
    return null;
  }
  return value as RawChunk;
}

interface CollectedAnswer {
  /** 回答正文 */
  text: string;
  /** 检索命中的引用片段（data-citations part） */
  citations: unknown;
  /** 输出审核结果（data-moderation part） */
  moderation: unknown;
  /** 流内错误文案 */
  errorText: string | null;
}

/**
 * 把 UI message stream 整个读完，汇总成一段 JSON 回答。
 *
 * 为什么不直接用 streamText 的 .text：那会把 RAG 那一段逻辑复制一遍，
 * 两条链路迟早会走偏。这里读的是**跟 SSE 端点完全同一个流**，
 * 所以「流式看到的」和「一次性拿到的」内容必然一致。
 */
async function collectStream(stream: ReadableStream<unknown>): Promise<CollectedAnswer> {
  const reader = stream.getReader();
  let text = '';
  let citations: unknown = null;
  let moderation: unknown = null;
  let errorText: string | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const chunk = asChunk(value);
    if (chunk === null) {
      continue;
    }
    if (chunk.type === 'text-delta' && typeof chunk.delta === 'string') {
      text += chunk.delta;
    } else if (chunk.type === 'data-citations') {
      citations = chunk.data ?? null;
    } else if (chunk.type === 'data-moderation') {
      moderation = chunk.data ?? null;
    } else if (chunk.type === 'error' && typeof chunk.errorText === 'string') {
      errorText = chunk.errorText;
    }
  }

  return { text, citations, moderation, errorText };
}

// ===== ★ 提问（JSON）=====

publicApiRouter.post('/chat', async (ctx) => {
  const principal = currentApiKey(ctx);
  const input = askBodySchema.parse(ctx.request.body ?? {});
  const tenant = await resolveTenant(ctx, principal);
  const session = await resolveOrCreateSession(ctx, tenant, input.session_id);

  // 跑一轮对话（限流 / 预算 / 审核 / 落库 / 历史 / 提示词，全在开流之前）
  const turn = await runChatTurn({
    ctx,
    session,
    tenant,
    parseBody: (maxInputChars) => parseQuestion(input.question, maxInputChars),
    rateLimitScope: `apikey:${principal.keyId}`,
    traceName: 'api.chat',
    traceKind: 'api',
  });

  // ⚠️ 这一条**不设** ctx.respond = false：流是我们自己消费的，
  //    所以生成失败还能正常返 5xx JSON（不用像 SSE 那样只能走流内 error）。
  const collected = await collectStream(turn.stream);

  if (collected.text.trim() === '') {
    // 空回答 = 这一轮生成失败了（chat.ts 会把空正文的 assistant 行标成 failed）。
    // 宁可返 500 让调用方重试，也不要回一个「答上来了但是空的」。
    throw new AppError(collected.errorText ?? '回答生成失败，请稍后重试', 'LLM_ERROR', 500);
  }

  ctx.body = {
    session_id: session.id,
    message_id: turn.assistantRowId,
    answer: collected.text,
    citations: collected.citations,
    moderation: collected.moderation,
  };
});

// ===== ★ 提问（SSE 流式）=====

publicApiRouter.post('/chat/stream', async (ctx) => {
  const principal = currentApiKey(ctx);
  const input = askBodySchema.parse(ctx.request.body ?? {});
  const tenant = await resolveTenant(ctx, principal);
  const session = await resolveOrCreateSession(ctx, tenant, input.session_id);

  const turn = await runChatTurn({
    ctx,
    session,
    tenant,
    parseBody: (maxInputChars) => parseQuestion(input.question, maxInputChars),
    rateLimitScope: `apikey:${principal.keyId}`,
    traceName: 'api.chat.stream',
    traceKind: 'api',
  });

  ctx.respond = false;
  await pipeUIMessageStreamToResponse({
    response: ctx.res,
    status: 200,
    stream: turn.stream,
    ...(config.CHAT.KEEPALIVE_MS > 0 ? { keepAliveMs: config.CHAT.KEEPALIVE_MS } : {}),
  });
});
