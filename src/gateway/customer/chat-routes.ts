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
  isMessageFavoriteSupported,
  listSessions,
  loadHistoryRows,
  loadOwnedSession,
  loadSessionUiMessages,
  parseChatRequest,
  renameSession,
  resolveRegenerateTarget,
  setMessageFavorite,
  setSessionFavorite,
  type ChatRequestBody,
  type ParsedRequest,
} from '../../services/chat';
import { resolveLlmSettings } from '../../services/llm-settings';
import { buildMemoryTextForChat } from '../../services/memory';
import { resolveTenantPrompt } from '../../services/prompt-registry';
import { checkRateLimit } from '../../services/rate-limit';
import { loadSummaryState } from '../../services/session-summary';
import { guardUserInput } from '../../services/security-guard';
import { getBudgetStatus } from '../../services/cost-tracking';
import { getSettingValue } from '../../services/tenant-settings';
import { startTrace, type TraceKind } from '../../services/trace';
import { resolveTenantTools } from '../../tools/resolve';
import {
  grantToolApproval,
  loadToolApprovals,
  rejectToolApproval,
} from '../../services/tool-approvals';
import { buildWorkflowHint } from '../../workflows/engine';

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
 *   PATCH  /messages/:id/favorite   📌 消息级收藏（迁移 037）
 *
 * 跨租户隔离：会话一律按 (id, tenant_id, user_id) 三元组查，
 * 别人的会话按「不存在」处理（404 而不是 403），不泄露这个 id 是否存在。
 *
 * 本文件同时导出 `runChatTurn` —— E1 的公开挂件 / 对外 REST API 复用同一套
 * RAG + LLM 链路（详见下面 runChatTurn 的注释）。
 */

export const customerChatRouter = new Router({ prefix: '/api/v1/customer' });

customerChatRouter.use(jwtAuth, requireCustomer);

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
  /** 只看收藏的会话（12-e 裁定表 #7） */
  favorite: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
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
  ctx.body = await listSessions(
    actorFromJwt(currentUser(ctx)),
    input.page,
    input.page_size,
    input.favorite,
  );
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

/**
 * PATCH /sessions/:id/favorite —— 收藏 / 取消收藏（12-e 裁定表 #7）
 *
 * body 不带 / 带 null = **切换**；带 true / false = 设成指定状态。
 */
customerChatRouter.patch('/sessions/:id/favorite', async (ctx) => {
  const body = (ctx.request.body ?? {}) as { favorite?: boolean | null };
  const favorite = await setSessionFavorite(
    ctx.params.id ?? '',
    actorFromJwt(currentUser(ctx)),
    body.favorite === undefined ? null : body.favorite,
  );
  ctx.body = { id: ctx.params.id ?? '', favorite };
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

// ============================================================
// ★ 共享的「跑一轮对话」执行器
// ============================================================

/**
 * 一轮对话要做的全部准备工作，**开流之前**必须做完的那些事。
 *
 * 为什么抽出来：E1 的两条新链路（公开挂件 / 对外 REST API）跟 customer 前台
 * 用的是**同一套 RAG + LLM 链路**（检索 → 拼提示词 → 流式生成 → 落库 → 记账）。
 * 三处各写一遍的话，任何一次修复（比如「预算检查要放在花钱之前」）都得改三个地方，
 * 漏一个就是线上事故。所以这里抽成一个函数，三条链路共用。
 *
 * ⚠️ **SSE 的错误时机分界线**（最容易踩的坑）：
 *   响应头一旦写出去，src/gateway/error-handler.ts 就再也改不动响应了。
 *   所以下面这个函数里的每一步都必须「失败时还能抛异常」——
 *   校验入参、限流、预算、凭据、审核、落库、历史查询、记忆查询，全部在开流之前做完。
 *   函数返回之后调用方才 `ctx.respond = false` 把流 pipe 出去。
 */
export interface ChatTurnOptions {
  ctx: Context;
  /** 本轮对话所属的会话（归属已由调用方校验过） */
  session: Session;
  /** 租户（提示词里的 {{tenantName}} / 租户级配置都要用） */
  tenant: Tenant;
  /**
   * 解析本轮输入。
   *
   * 回调收到的是**租户侧的** maxInputChars ——「单条消息多长算超长」是租户可配的
   * （tenant_settings.max_input_chars），拿到租户值才能判。解析失败请抛 ValidationError
   * （此时还没开流，能正常返 400）。
   */
  parseBody: (maxInputChars: number) => ParsedRequest;
  /**
   * 限流维度标识（同一租户下区分不同调用者）：
   *   - customer：用户 id
   *   - widget  ：`widget:<会话 id>`（匿名，没有用户 id）
   *   - api     ：`apikey:<key id>`
   */
  rateLimitScope: string;
  /** trace 名称（观测里区分入口） */
  traceName: string;
  /** trace 类型 */
  traceKind: TraceKind;
}

export interface ChatTurnResult {
  /** UI message stream（还没写出去，由调用方 pipe 到响应） */
  stream: ReturnType<typeof createChatStream>;
  /** assistant 占位行的 id（跟前端看到的 message.id 一致） */
  assistantRowId: string;
  /** 真正送进模型的文本（已脱敏） */
  safeUserText: string;
}

/**
 * 跑一轮对话的准备阶段，返回可以直接 pipe 的 UI message stream。
 *
 * 失败时抛异常（还没开流，调用方能正常返 4xx / 5xx）。
 */
export async function runChatTurn(options: ChatTurnOptions): Promise<ChatTurnResult> {
  const { ctx, session, tenant } = options;

  // 观测（D2）：trace 从这里开始，覆盖「限流 → 审核 → 检索 → 生成 → 记账」全程。
  // 归属校验失败不记 trace —— 那是客户端打错了，不是链路问题。
  const trace = startTrace({
    tenantId: session.tenant_id,
    userId: session.user_id,
    sessionId: session.id,
    name: options.traceName,
    kind: options.traceKind,
    channel: session.channel,
  });
  const requestSpan = trace.span('http.request', 'http', {
    method: ctx.method,
    path: ctx.path,
  });

  try {
    // 1) 限流（D5）。**必须在任何花钱的动作之前** —— 限流就是为了挡住
    //    「疯狂重试 / 刷接口」这类请求，排在 LLM 调用后面就没有意义了。
    const rateLimit = await checkRateLimit(session.tenant_id, options.rateLimitScope);
    if (!rateLimit.allowed) {
      const retryAfterSec = Math.max(1, Math.ceil(rateLimit.retryAfterMs / 1000));
      ctx.set('Retry-After', String(retryAfterSec));
      throw new RateLimitError(
        `请求过于频繁，请 ${retryAfterSec} 秒后再试`,
        rateLimit.retryAfterMs,
      );
    }

    // 2) 成本预算（D3）。默认只告警不拦截；COST_BUDGET_BLOCK=true 时才真的拒。
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

    // 3) 租户级配置 + 凭据 —— 必须排在入参校验之前：
    //    「单条消息多长算超长」是租户可配的（tenant_settings.max_input_chars），
    //    拿不到租户值就没法判。缺凭据也要在这里报出来，否则用户只看到一个空流。
    const llm = await resolveLlmSettings(session.tenant_id);
    if (llm.apiKey.trim() === '' || llm.baseUrl.trim() === '' || llm.model.trim() === '') {
      throw new AppError(
        '对话服务未配置：请在「模型 & 提示词」里填写模型与 API Key，或联系平台管理员配置 .env',
        'LLM_NOT_CONFIGURED',
        503,
      );
    }

    // 4) 入参（AI SDK 的 HttpChatTransport 协议：{ id, messages, trigger, messageId }）
    const parsed = options.parseBody(llm.maxInputChars);

    // 5) 安全防护（D4）：脱敏 → 敏感词 → 注入检测。
    //    **必须排在落库之前** —— 拦截的请求不能留下 user 行，
    //    脱敏后的文本才是允许落库和送进模型的内容。
    const guardSpan = trace.span('security.guard', 'guard');
    let guard: Awaited<ReturnType<typeof guardUserInput>>;
    try {
      guard = await guardUserInput(parsed.userText, {
        tenantId: session.tenant_id,
        userId: session.user_id,
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

    // 5.5) 「重新生成」的目标行（开流之前查好）。
    //      角色决定语义：
    //        - assistant → **覆盖**这条回答（复用同一行，不多插一行）
    //        - user     → **重跑**这个提问（用户行已经在库里，不重复插；回答另起一行）
    const target =
      parsed.regenerateTargetId === null
        ? null
        : await resolveRegenerateTarget(session.id, session.tenant_id, parsed.regenerateTargetId);

    // 6) 落库 user 行。「重新生成」时不再重复插 —— 那条已经在库里了
    if (target === null) {
      await insertUserMessage(session, safeUserText);
    }

    // 7) 落库 assistant 占位行。重新生成时复用原行 id，
    //    配合 createUIMessageStream 的 generateId 实现「覆盖同一条」而不是多插一行
    const reuseAssistantId =
      target !== null && target.role === 'assistant' ? target.id : undefined;
    const assistantRowId = await insertAssistantPlaceholder(session, reuseAssistantId);

    // 8) 读历史（开流之前查完：DB 挂了还能正常返 500）
    //    ⚠️ 覆盖老回答时要把那条老回答**排除**（模型不该看到自己上一版答案）；
    //    「重跑某个提问」时**要留着**那条用户消息 —— 它就是本轮的问题。
    const historyRows = await loadHistoryRows(
      session.id,
      reuseAssistantId === undefined ? [] : [reuseAssistantId],
    );

    // 8.5) 用户长期记忆（B4）。同样在开流之前查好 ——
    //      查库失败要能返 500，而不是变成流内 error。
    //      匿名会话（挂件 / 对外 API）没有 user_id → 没有个人记忆，直接跳过。
    //      ⚠️ 传的是**安全处理后**的文本（safeUserText）——
    //         脱敏后的内容才是真正送进模型的东西，用它算相关性才对得上。
    const memoryText =
      session.user_id === null
        ? ''
        : await buildMemoryTextForChat(session.tenant_id, session.user_id, safeUserText);

    // 8.6) 会话摘要（B1 摘要压缩）。同样在开流之前查好 ——
    //      查库失败要能返 500，而不是变成流内 error。
    //      里面带「摘要覆盖到哪条消息为止」的边界，用来把已经摘要过的历史切掉。
    const summaryState = await loadSummaryState(session.id, session.tenant_id);

    // 8.7) 工具（B3 工具调用）。同样在开流之前查好 ——
    //      查库失败要能返 500，而不是变成流内 error。
    //      这里只查「本租户启用的工具」—— 别的租户注册的工具永远不会出现在这里。
    const tools = await resolveTenantTools(session.tenant_id);

    // 8.8) 用户对敏感工具的处置（B3 HITL）。同样在开流之前查好。
    //      keys        = 已批准的（闸门放行用）
    //      rejections  = 用户取消过的（闸门回「用户拒绝」）
    //      approvedArgs = 工具名 → 用户确认的那份入参（模型改参数时回传给它）
    //      pendingToolApprovals = 提示词里的提醒（已确认的「请再调一次」、
    //                            已取消的「不要再调」）
    const approvals = await loadToolApprovals(session.id, session.tenant_id);
    const toolApprovals = approvals.keys;
    const toolRejections = approvals.rejections;
    const toolApprovedArgs = approvals.approvedArgs;
    const pendingToolApprovals = [...approvals.pending, ...approvals.rejected].map((p) => ({
      tool_name: p.tool_name,
      args: p.args,
      state: p.state === 'rejected' ? ('rejected' as const) : ('approved' as const),
    }));

    // 8.9) 进行中的工作流进度（B5）。同样在开流之前查好。
    //      这是「断点恢复」的补偿手段 —— 本项目的流程是模型驱动的，
    //      进程重启 / 隔天回来之后，得靠这段提示告诉模型「接着做」。
    const workflowHint = await buildWorkflowHint(session.tenant_id, session.id);

    // 8.10) 多代理开关（B6）。**没配 = 开**（registry 的 fallback 是 true）。
    //       委派是额外的一次 LLM 调用，嫌贵的租户可以关掉。
    const multiAgentRaw = await getSettingValue(session.tenant_id, 'multi_agent_enabled');
    const multiAgentEnabled = multiAgentRaw !== false;

    // 9) 租户级配置：模型 / 温度 / 缓存开关（§C4）+ 生效的提示词正文（§C3）
    //    都在开流之前查完；租户没配就回落 .env 进程默认 + 内置默认提示词
    const resolvedPrompt = await resolveTenantPrompt(
      session.tenant_id,
      llm.promptVersion,
      tenant.name,
    );
    if (llm.degraded !== null) {
      logger.warn({ sessionId: session.id, reason: llm.degraded }, '租户 LLM 配置降级');
    }

    requestSpan.end({ regenerate: parsed.isRegenerate });

    const stream = createChatStream({
      session,
      tenantName: tenant.name,
      assistantRowId,
      userText: safeUserText,
      historyRows,
      llm,
      // 用户本轮点了「思考模式」→ 这一轮开推理（docs/04-b §4.4）
      thinkingEnabled: parsed.thinking,
      promptContent: resolvedPrompt.origin === 'tenant' ? resolvedPrompt.text : null,
      memoryText,
      summaryState,
      summaryTokenBudget: llm.summaryTokenBudget,
      tools,
      toolApprovals,
      toolRejections,
      toolApprovedArgs,
      pendingToolApprovals,
      workflowHint,
      multiAgentEnabled,
      ip: ctx.ip,
      trace,
    });

    logger.info(
      {
        sessionId: session.id,
        tenantId: session.tenant_id,
        provider: llm.provider,
        model: llm.model,
        llmSource: llm.source,
        promptVersion: resolvedPrompt.version,
        promptOrigin: resolvedPrompt.origin,
        regenerate: parsed.isRegenerate,
      },
      '开始一次对话',
    );

    return { stream, assistantRowId, safeUserText };
  } catch (err: unknown) {
    // 开流之前的失败：trace 记 error；开流之后的失败由 chat.ts 的 onEnd 收尾
    requestSpan.fail(err);
    await trace.fail(err);
    throw err;
  }
}

// ===== ★ 流式发消息 =====

/**
 * 错误时机的分界线就在下面那行 `ctx.respond = false`：
 *
 *   ↑ 之前：任何失败都还能被 src/gateway/error-handler.ts 转成正常的 4xx / 5xx JSON
 *   ↓ 之后：响应头已锁死，只能靠流内 error part 告诉客户端
 *
 * 所以入参校验、会话归属、LLM 凭据、落库、历史查询全部放在 runChatTurn 里，一样都不能漏。
 */
customerChatRouter.post('/sessions/:id/messages', async (ctx) => {
  const user = currentUser(ctx);
  const actor = actorFromJwt(user);
  const sessionId = ctx.params.id ?? '';

  // 1) 会话归属（跨租户 / 跨用户一律 404）
  const session = await loadOwnedSession(sessionId, actor);

  // 2) 租户（提示词里的 {{tenantName}} / 租户级配置都要用）
  const tenant = await Tenant.findByPk(session.tenant_id);
  if (tenant === null) {
    throw new NotFoundError('租户');
  }

  // 3) 跑一轮对话（限流 / 预算 / 审核 / 落库 / 历史 / 记忆 / 提示词，全在开流之前）
  const turn = await runChatTurn({
    ctx,
    session,
    tenant,
    parseBody: (maxInputChars) =>
      parseChatRequest(ctx.request.body as ChatRequestBody, maxInputChars),
    rateLimitScope: actor.userId,
    traceName: 'chat.message',
    traceKind: 'chat',
  });

  // 4) 把流交给 Node 响应。
  //    pipeUIMessageStreamToResponse 内部已经处理了 backpressure、flush()、
  //    以及客户端断连 → reader.cancel()，所以断连时 streamText 的 fetch 会被中止，
  //    onEnd 照样触发（消息状态记为 cancelled，已生成的部分正文保留）。
  ctx.respond = false;
  await pipeUIMessageStreamToResponse({
    response: ctx.res,
    status: 200,
    stream: turn.stream,
    // SSE 那几个头 SDK 自己会 merge 进来（content-type / cache-control /
    // connection / x-accel-buffering / x-vercel-ai-ui-message-stream），别重复设。
    // keepAliveMs 会让流一开就发一条 `: stream-open` 注释，前端的 loading 立刻亮，
    // 也能避免长检索被 nginx 掐断。
    ...(config.CHAT.KEEPALIVE_MS > 0 ? { keepAliveMs: config.CHAT.KEEPALIVE_MS } : {}),
  });
});

// ===== 工具确认（B3 · HITL）=====

const toolApprovalBodySchema = z.object({
  /** 注册名（模型调用的名字） */
  tool_name: z.string().trim().min(1).max(64),
  /** 模型当时给的入参 —— 批准绑定到「工具名 + 这份入参」 */
  args: z.unknown(),
});

/**
 * POST /sessions/:id/tool-approvals/reject —— 用户**取消**一次敏感工具调用
 *
 * 点了「确认执行」还能反悔：拒绝之后闸门会回「用户拒绝执行这个操作」，
 * 模型如实告诉用户，**不会再问第三次**。
 */
customerChatRouter.post('/sessions/:id/tool-approvals/reject', async (ctx) => {
  const user = currentUser(ctx);
  const actor = actorFromJwt(user);
  const sessionId = ctx.params.id ?? '';
  const input = toolApprovalBodySchema.parse(ctx.request.body ?? {});

  // 会话归属（跨租户 / 跨用户一律 404）
  await loadOwnedSession(sessionId, actor);

  const rejected = await rejectToolApproval(sessionId, actor.tenantId, input.tool_name, input.args);
  ctx.body = { ok: true, tool_name: input.tool_name, approval_key: rejected.key };
});

/**
 * POST /sessions/:id/tool-approvals —— 用户确认一次敏感工具调用
 *
 * 前端在工具调用卡片上点「确认执行」时调它。确认记录写进会话的 metadata，
 * 下一次模型用**相同参数**再调这个工具时闸门就放行（见 src/tools/execute.ts）。
 *
 * 入参变了就是另一件事 —— 批准不通用，模型换参数要重新确认。
 */
customerChatRouter.post('/sessions/:id/tool-approvals', async (ctx) => {
  const user = currentUser(ctx);
  const actor = actorFromJwt(user);
  const sessionId = ctx.params.id ?? '';
  const input = toolApprovalBodySchema.parse(ctx.request.body ?? {});

  // 会话归属（跨租户 / 跨用户一律 404）
  await loadOwnedSession(sessionId, actor);

  const granted = await grantToolApproval(sessionId, actor.tenantId, input.tool_name, input.args);
  ctx.body = { ok: true, tool_name: input.tool_name, approval_key: granted.key };
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

// ===== 消息级收藏（docs/04-b §4.2「📌 收藏」）=====

const messageFavoriteBodySchema = z.object({
  favorite: z.boolean(),
});

/**
 * PATCH /messages/:id/favorite —— 收藏 / 取消收藏一条 AI 回答
 *
 * ⚠️ **归属校验跟反馈端点同一套**：消息 → 会话 → (tenant_id, user_id)。
 *    跨租户 / 跨用户一律 404（不泄露这个 id 是否存在）。
 *
 * ⚠️ **不写审计** —— 消息收藏是**用户自己的数据**，跟会话收藏（sessions.favorite）一致。
 */
customerChatRouter.patch('/messages/:id/favorite', async (ctx) => {
  const user = currentUser(ctx);
  const input = messageFavoriteBodySchema.parse(ctx.request.body ?? {});

  // 迁移 037 没跑 → 这一列不存在，功能不可用（但聊天本身照常）
  if (!isMessageFavoriteSupported()) {
    throw new AppError(
      '消息收藏功能暂不可用，请联系平台管理员执行数据库迁移',
      'FEATURE_UNAVAILABLE',
      503,
    );
  }

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

  const favorite = await setMessageFavorite(message.id, user.tenant_id, input.favorite);
  ctx.body = { id: message.id, favorite };
});
