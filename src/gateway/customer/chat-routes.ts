import Router from '@koa/router';
import type { Context } from 'koa';
import { z } from 'zod';
import { pipeUIMessageStreamToResponse } from 'ai';
import { config } from '../../config';
import { Message, Session, Tenant } from '../../models';
import { jwtAuth } from '../jwt-base';
import { requireCustomer } from './middleware';
import { AppError, BudgetExceededError, ContentBlockedError, NotFoundError, RateLimitError } from '../../lib/errors';
import { logger } from '../../logger';
import type { TenantUserJwtPayload } from '../../lib/jwt';
import {
  actorFromJwt,
  createChatStream,
  createSession,
  deleteSession,
  insertAssistantPlaceholder,
  insertUserMessage,
  listSessions,
  loadHistoryRows,
  loadOwnedSession,
  loadSessionUiMessages,
  parseChatRequest,
  renameSession,
  type ChatRequestBody,
} from '../../services/chat';
import { resolveLlmSettings } from '../../services/llm-settings';
import { resolveTenantPrompt } from '../../services/prompt-registry';
import { checkRateLimit } from '../../services/rate-limit';
import { guardUserInput } from '../../services/security-guard';
import { getBudgetStatus } from '../../services/cost-tracking';
import { getSettingValue } from '../../services/tenant-settings';
import { startTrace, type TraceHandle } from '../../services/trace';

/**
 * customer 对话路由 —— 详见 docs/12-b-需求-ai对话能力.md §B1（多轮对话 + LLM 流式）
 * 路由前缀：/api/v1/customer　鉴权：customer 角色（jwtAuth + requireCustomer）
 *
 * 端点：
 *   GET    /sessions                会话列表（分页）
 *   POST   /sessions                新建会话
 *   GET    /sessions/:id            会话详情
 *   PATCH  /sessions/:id            重命名
 *   DELETE /sessions/:id            删会话（messages 由 DB 的 CASCADE 连带删）
 *   GET    /sessions/:id/messages   历史消息（useChat 可直接吃）
 *   POST   /sessions/:id/messages   ★ 流式发消息（SSE）
 *   POST   /messages/:id/feedback   👍 / 👎 反馈
 *
 * 跨租户隔离：会话一律按 (id, tenant_id, user_id) 三元组查，
 * 别人的会话按「不存在」处理（404 而不是 403），不泄露这个 id 是否存在。
 */

export const customerChatRouter = new Router({ prefix: '/api/v1/customer' });

customerChatRouter.use(jwtAuth, requireCustomer);

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
});

const createBodySchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
});

const renameBodySchema = z.object({
  title: z.string().trim().min(1, '标题不能为空').max(200),
});

const messagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

const feedbackBodySchema = z.object({
  /** 1 = 点赞 / -1 = 点踩 / null = 清除反馈 */
  feedback: z.union([z.literal(1), z.literal(-1), z.null()]),
  feedback_text: z.string().trim().max(1000).optional(),
});

/** 取当前 customer —— 中间件已经保证一定存在且是 customer 角色 */
function currentUser(ctx: Context): TenantUserJwtPayload {
  return ctx.state.customerUser as TenantUserJwtPayload;
}

// ===== 会话 CRUD =====

customerChatRouter.get('/sessions', async (ctx) => {
  const input = listQuerySchema.parse(ctx.query);
  ctx.body = await listSessions(actorFromJwt(currentUser(ctx)), input.page, input.page_size);
});

customerChatRouter.post('/sessions', async (ctx) => {
  const input = createBodySchema.parse(ctx.request.body ?? {});
  const session = await createSession(actorFromJwt(currentUser(ctx)), input.title);
  ctx.status = 201;
  ctx.body = {
    id: session.id,
    title: session.title,
    channel: session.channel,
    status: session.status,
    started_at: session.started_at.toISOString(),
  };
});

customerChatRouter.get('/sessions/:id', async (ctx) => {
  const session = await loadOwnedSession(ctx.params.id ?? '', actorFromJwt(currentUser(ctx)));
  ctx.body = {
    id: session.id,
    title: session.title,
    channel: session.channel,
    status: session.status,
    started_at: session.started_at.toISOString(),
  };
});

customerChatRouter.patch('/sessions/:id', async (ctx) => {
  const input = renameBodySchema.parse(ctx.request.body);
  const session = await renameSession(
    ctx.params.id ?? '',
    actorFromJwt(currentUser(ctx)),
    input.title,
  );
  ctx.body = { id: session.id, title: session.title };
});

customerChatRouter.delete('/sessions/:id', async (ctx) => {
  await deleteSession(ctx.params.id ?? '', actorFromJwt(currentUser(ctx)));
  ctx.status = 204;
});

// ===== 历史消息 =====

customerChatRouter.get('/sessions/:id/messages', async (ctx) => {
  const input = messagesQuerySchema.parse(ctx.query);
  const sessionId = ctx.params.id ?? '';
  // 先校验归属再读消息 —— 不校验就读等于把别人的会话内容读出来
  await loadOwnedSession(sessionId, actorFromJwt(currentUser(ctx)));
  ctx.body = await loadSessionUiMessages(sessionId, input.limit);
});

// ===== ★ 流式发消息 =====

/**
 * 错误时机的分界线就在下面那行 `ctx.respond = false`：
 *
 *   ↑ 之前：任何失败都还能被 src/gateway/error-handler.ts 转成正常的 4xx / 5xx JSON
 *   ↓ 之后：响应头已锁死，只能靠流内 error part 告诉客户端
 *
 * 所以入参校验、会话归属、LLM 凭据、落库、历史查询全部放在上面，一样都不能漏。
 */
customerChatRouter.post('/sessions/:id/messages', async (ctx) => {
  const user = currentUser(ctx);
  const actor = actorFromJwt(user);
  const sessionId = ctx.params.id ?? '';

  // 1) 会话归属（跨租户 / 跨用户一律 404）
  const session = await loadOwnedSession(sessionId, actor);

  // 2) 观测（D2）：trace 从这里开始，覆盖「限流 → 审核 → 检索 → 生成 → 记账」全程。
  //    归属校验失败（404）不记 trace —— 那是客户端打错了，不是链路问题。
  const trace = startTrace({
    tenantId: session.tenant_id,
    userId: actor.userId,
    sessionId: session.id,
    name: 'chat.message',
    kind: 'chat',
    channel: session.channel,
  });
  const requestSpan = trace.span('http.request', 'http', {
    method: ctx.method,
    path: ctx.path,
  });

  try {
    // 3) 限流（D5）。**必须在任何花钱的动作之前** —— 限流就是为了挡住
    //    「疯狂重试 / 刷接口」这类请求，排在 LLM 调用后面就没有意义了。
    const rateLimit = await checkRateLimit(session.tenant_id, actor.userId);
    if (!rateLimit.allowed) {
      const retryAfterSec = Math.max(1, Math.ceil(rateLimit.retryAfterMs / 1000));
      ctx.set('Retry-After', String(retryAfterSec));
      throw new RateLimitError(
        `请求过于频繁，请 ${retryAfterSec} 秒后再试`,
        rateLimit.retryAfterMs,
      );
    }

    // 4) 成本预算（D3）。默认只告警不拦截；COST_BUDGET_BLOCK=true 时才真的拒。
    //    只在「真的要拦」时才去读租户配置 —— 默认配置下这一段不产生任何 DB 查询
    //    （告警那条路在流结束时算，见 src/services/chat.ts 的 onEnd）。
    if (config.COST.BUDGET_BLOCK) {
      const budgetRaw = await getSettingValue(session.tenant_id, 'monthly_token_budget');
      const budget = typeof budgetRaw === 'number' ? budgetRaw : 0;
      if (budget > 0) {
        const status = await getBudgetStatus(session.tenant_id, budget);
        if (status.exceeded) {
          throw new BudgetExceededError('本月用量已超出预算，请联系管理员调整配额', {
            used_tokens: status.used,
            limit_tokens: status.limit,
          });
        }
      }
    }

    // 5) 租户级配置 + 凭据 —— 必须排在入参校验之前：
    //    「单条消息多长算超长」是租户可配的（tenant_settings.max_input_chars），
    //    拿不到租户值就没法判。缺凭据也要在这里报出来，否则用户只看到一个空流。
    const llm = await resolveLlmSettings(session.tenant_id);

    // 6) 入参（AI SDK 的 HttpChatTransport 协议：{ id, messages, trigger, messageId }）
    const parsed = parseChatRequest(ctx.request.body as ChatRequestBody, llm.maxInputChars);
    if (llm.apiKey.trim() === '' || llm.baseUrl.trim() === '' || llm.model.trim() === '') {
      throw new AppError(
        '对话服务未配置：请在「模型 & 提示词」里填写模型与 API Key，或联系平台管理员配置 .env',
        'LLM_NOT_CONFIGURED',
        503,
      );
    }

    // 7) 安全防护（D4）：脱敏 → 敏感词 → 注入检测。
    //    **必须排在落库之前** —— 拦截的请求不能留下 user 行，
    //    脱敏后的文本才是允许落库和送进模型的内容。
    const guardSpan = trace.span('security.guard', 'guard');
    let guard: Awaited<ReturnType<typeof guardUserInput>>;
    try {
      guard = await guardUserInput(parsed.userText, {
        tenantId: session.tenant_id,
        userId: actor.userId,
        llm: { apiKey: llm.apiKey, baseUrl: llm.baseUrl, model: llm.model },
        ip: ctx.ip,
      });
      guardSpan.end({ blocked: guard.blocked, category: guard.category ?? null });
    } catch (err: unknown) {
      guardSpan.fail(err);
      throw err;
    }
    if (guard.blocked) {
      throw new ContentBlockedError(guard.reason ?? '内容违规', guard.category ?? 'sensitive');
    }
    const safeUserText = guard.text;

    // 8) 落库 user 行。「重新生成」时不再重复插 —— 那条已经在库里了
    if (!parsed.isRegenerate) {
      await insertUserMessage(session, safeUserText);
    }

    // 9) 落库 assistant 占位行。重新生成时复用原行 id，
    //    配合 createUIMessageStream 的 generateId 实现「覆盖同一条」而不是多插一行
    const assistantRowId = await insertAssistantPlaceholder(
      session,
      parsed.regenerateTargetId ?? undefined,
    );

    // 10) 读历史（开流之前查完：DB 挂了还能正常返 500）
    const historyRows = await loadHistoryRows(
      session.id,
      parsed.regenerateTargetId === null ? [] : [parsed.regenerateTargetId],
    );

    // 11) 租户级配置：模型 / 温度 / 缓存开关（§C4）+ 生效的提示词正文（§C3）
    //     都在开流之前查完；租户没配就回落 .env 进程默认 + 内置默认提示词
    const tenant = await Tenant.findByPk(session.tenant_id);
    const tenantName = tenant?.name ?? '本公司';
    const llmSettings = await resolveLlmSettings(session.tenant_id);
    const resolvedPrompt = await resolveTenantPrompt(
      session.tenant_id,
      llmSettings.promptVersion,
      tenantName,
    );
    if (llmSettings.degraded !== null) {
      logger.warn({ sessionId: session.id, reason: llmSettings.degraded }, '租户 LLM 配置降级');
    }

    requestSpan.end({ regenerate: parsed.isRegenerate });

    const stream = createChatStream({
      session,
      tenantName,
      tenantSettings: tenant?.settings ?? null,
      assistantRowId,
      userText: safeUserText,
      historyRows,
      llm: llmSettings,
      promptContent: resolvedPrompt.origin === 'tenant' ? resolvedPrompt.text : null,
      ip: ctx.ip,
      trace,
    });

    logger.info(
      {
        sessionId: session.id,
        tenantId: session.tenant_id,
        provider: llmSettings.provider,
        model: llmSettings.model,
        llmSource: llmSettings.source,
        promptVersion: resolvedPrompt.version,
        promptOrigin: resolvedPrompt.origin,
        regenerate: parsed.isRegenerate,
      },
      '开始一次对话',
    );

    // 8) 把流交给 Node 响应。
    //    pipeUIMessageStreamToResponse 内部已经处理了 backpressure、flush()、
    //    以及客户端断连 → reader.cancel()，所以断连时 streamText 的 fetch 会被中止，
    //    onEnd 照样触发（消息状态记为 cancelled，已生成的部分正文保留）。
    ctx.respond = false;
    await pipeUIMessageStreamToResponse({
      response: ctx.res,
      status: 200,
      stream,
      // SSE 那几个头 SDK 自己会 merge 进来（content-type / cache-control /
      // connection / x-accel-buffering / x-vercel-ai-ui-message-stream），别重复设。
      // keepAliveMs 会让流一开就发一条 `: stream-open` 注释，前端的 loading 立刻亮，
      // 也能避免长检索被 nginx 掐断。
      ...(config.CHAT.KEEPALIVE_MS > 0 ? { keepAliveMs: config.CHAT.KEEPALIVE_MS } : {}),
    });
  } catch (err: unknown) {
    // 开流之前的失败：trace 记 error；开流之后的失败由 chat.ts 的 onEnd 收尾
    requestSpan.fail(err);
    await trace.fail(err);
    throw err;
  }
});

// ===== 反馈 =====

customerChatRouter.post('/messages/:id/feedback', async (ctx) => {
  const user = currentUser(ctx);
  const input = feedbackBodySchema.parse(ctx.request.body);

  // 消息 → 会话 → 归属，逐层校验（消息本身不存 user_id，归属在会话上）
  const message = await Message.findOne({
    where: { id: ctx.params.id ?? '', tenant_id: user.tenant_id },
  });
  if (message === null) {
    throw new NotFoundError('消息');
  }
  const session = await Session.findOne({
    where: { id: message.session_id, tenant_id: user.tenant_id, user_id: user.sub },
    attributes: ['id'],
  });
  if (session === null) {
    throw new NotFoundError('消息');
  }

  await Message.update(
    {
      feedback: input.feedback,
      feedback_text: input.feedback_text ?? null,
      feedback_at: input.feedback === null ? null : new Date(),
    },
    { where: { id: message.id } },
  );
  ctx.body = { id: message.id, feedback: input.feedback };
});