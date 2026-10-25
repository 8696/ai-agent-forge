import { Op } from 'sequelize';
import { createAnthropic } from '@ai-sdk/anthropic';
import {
  createUIMessageStream,
  isReasoningUIPart,
  isTextUIPart,
  streamText,
  toUIMessageStream,
  type DataUIPart,
  type LanguageModelUsage,
  type ModelMessage,
  type SystemModelMessage,
  type UIMessageStreamWriterWithOutcome,
} from 'ai';
import type { ChatDataTypes, ChatUIMessage } from '@shared/types/chat';
import { Session, Message } from '../models';
import type { MessageStatus, MessageToolResults, MessageUsage } from '../models';
import type { DataPartShape } from '../models/Message';
import { NotFoundError, ValidationError } from '../lib/errors';
import { getBreaker, CircuitOpenError } from '../lib/circuit-breaker';
import { logger } from '../logger';
import { config, getLlm } from '../config';
import {
  estimateTokens,
  fitHistoryToBudget,
  fitHitsToBudget,
  type TokenCountableMessage,
} from '../lib/token-estimate';
import { buildPrompt, NO_HITS_NOTICE } from '../prompts';
import { resolveLlmSettings, type ResolvedLlmSettings } from './llm-settings';
import {
  buildSummaryBlockText,
  splitHistoryByBoundary,
  summarizeDroppedTurns,
  type SessionSummaryState,
} from './session-summary';
import { hybridSearch, type HybridHit, type RecallSource } from '../rag/hybrid-search';
import { rewriteQuery } from '../rag/query-rewrite';

/** 查询改写的超时（毫秒）—— 改写不能拖住用户请求 */
const QUERY_REWRITE_TIMEOUT_MS = 3000;
import type { TenantUserJwtPayload } from '../lib/jwt';
import { withTimeout } from '../lib/async';
import {
  guardAssistantOutput,
  OUTPUT_BLOCKED_TEXT,
  type GuardActor,
} from './security-guard';
import { checkBudgetAndAlert, recordLlmUsage } from './cost-tracking';
import { getSettingValue } from './tenant-settings';
import { extractAndApplyMemories } from './memory';
import type { SpanHandle, TraceHandle } from './trace';

/**
 * 对话服务层 —— B1 多轮对话 + LLM 流式（docs/12-b-需求-ai对话能力.md §B1）
 *
 * 定位跟 src/services/document-upload.ts 一致：**不绑 HTTP 路由**，只管业务。
 *
 * ------------------------------------------------------------------
 * ⚠️ 流式响应的一条铁律：SSE 一旦写出 header，src/gateway/error-handler.ts
 *    就再也改不动响应了。所以下面这个文件把失败点分成两类：
 *
 *   写流之前（还能正常返 4xx/5xx）：校验入参、校验会话归属、取 LLM 凭据、
 *     落 user 行、落 assistant 占位行、预算裁剪、拼提示词
 *
 *   写流之后（只能走流内 error）：真正的 LLM 网络请求、结果解析、落库
 * ------------------------------------------------------------------
 */

// ============================================================
// 会话 CRUD
// ============================================================

export interface SessionActor {
  tenantId: string;
  userId: string;
}

/** 从 JWT payload 拿出会话操作者（tenant_id / user_id 永远来自 token，绝不从 body 读） */
export function actorFromJwt(user: TenantUserJwtPayload): SessionActor {
  return { tenantId: user.tenant_id, userId: user.sub };
}

/**
 * 取会话并校验归属。
 *
 * **tenant_id + user_id 双重过滤**：别人的会话一律按「不存在」处理（抛 404 而不是 403），
 * 不泄露「这个 id 存在，只是你没权限」这个信息。跟 admin 侧 findOwned* 的处理一致。
 */
export async function loadOwnedSession(id: string, actor: SessionActor): Promise<Session> {
  const session = await Session.findOne({
    where: { id, tenant_id: actor.tenantId, user_id: actor.userId },
  });
  if (session === null) {
    throw new NotFoundError('会话');
  }
  return session;
}

export async function createSession(actor: SessionActor, title?: string): Promise<Session> {
  return Session.create({
    tenant_id: actor.tenantId,
    user_id: actor.userId,
    channel: 'web',
    status: 'active',
    title: title ?? null,
    started_at: new Date(),
  });
}

export interface SessionListResult {
  sessions: Array<{
    id: string;
    title: string | null;
    status: string;
    channel: string;
    message_count: number;
    started_at: string;
    last_message_at: string | null;
  }>;
  pagination: { page: number; page_size: number; total: number; total_pages: number };
}

export async function listSessions(
  actor: SessionActor,
  page: number,
  pageSize: number,
): Promise<SessionListResult> {
  const where = { tenant_id: actor.tenantId, user_id: actor.userId };
  const { rows, count } = await Session.findAndCountAll({
    where,
    order: [['started_at', 'DESC']],
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  // 消息条数 + 最后消息时间：一次查询算出，避免每行再 count 一次（N+1）
  const msgs = await Message.findAll({
    where: { session_id: { [Op.in]: rows.map((r) => r.id) } },
    attributes: ['session_id', 'created_at'],
  });
  const countBySession = new Map<string, number>();
  const lastAtBySession = new Map<string, Date>();
  for (const m of msgs) {
    countBySession.set(m.session_id, (countBySession.get(m.session_id) ?? 0) + 1);
    const prev = lastAtBySession.get(m.session_id);
    if (prev === undefined || m.created_at > prev) {
      lastAtBySession.set(m.session_id, m.created_at);
    }
  }

  return {
    sessions: rows.map((s) => ({
      id: s.id,
      title: s.title,
      status: s.status,
      channel: s.channel,
      message_count: countBySession.get(s.id) ?? 0,
      started_at: s.started_at.toISOString(),
      last_message_at: (lastAtBySession.get(s.id) ?? s.started_at).toISOString(),
    })),
    pagination: {
      page,
      page_size: pageSize,
      total: count,
      total_pages: Math.ceil(count / pageSize),
    },
  };
}

export async function renameSession(
  id: string,
  actor: SessionActor,
  title: string,
): Promise<Session> {
  const session = await loadOwnedSession(id, actor);
  session.title = title;
  await session.save();
  return session;
}

/** 删会话（messages 由 DB 的 ON DELETE CASCADE 连带删） */
export async function deleteSession(id: string, actor: SessionActor): Promise<void> {
  const session = await loadOwnedSession(id, actor);
  await session.destroy();
}

// ============================================================
// 消息持久化
// ============================================================

/** 首条用户消息截断成会话标题（04-b §4.7 规格：前 20 字） */
export const SESSION_TITLE_MAX = 20;

function titleFromFirstUserMessage(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length > SESSION_TITLE_MAX ? trimmed.slice(0, SESSION_TITLE_MAX) : trimmed;
}

export async function insertUserMessage(
  session: Session,
  text: string,
): Promise<Message> {
  const message = await Message.create({
    session_id: session.id,
    tenant_id: session.tenant_id,
    role: 'user',
    content: text,
    status: 'complete',
  });
  // 只在用户还没改过标题时自动填（title 为 null 说明从没生成过）
  if (session.title === null || session.title === '') {
    session.title = titleFromFirstUserMessage(text);
    await session.save();
  }
  return message;
}

/**
 * 建 assistant 占位行（status='streaming'、正文为空），返回 id。
 *
 * 为什么先建行再开流：进程被 kill / OOM 时这行会永远停在 streaming，
 * 至少留下了「用户问过什么」的痕迹；对比「流结束才插」，断连就整轮消失，
 * 用户会反复问同一个问题。
 *
 * 「重新生成」传 existingId：这条 assistant 已经在库里了，这里是**重置**而不是新建
 * —— 真的 INSERT 会撞 `messages.PRIMARY`（Duplicate entry），整轮对话直接 500。
 * 配合 createUIMessageStream 的 generateId，客户端看到的 id 也始终是同一个，
 * 刷新页面不会出现「同一个回答有两条」。
 */
export async function insertAssistantPlaceholder(
  session: Session,
  existingId?: string,
): Promise<string> {
  if (existingId !== undefined) {
    const existing = await Message.findOne({
      where: { id: existingId, session_id: session.id, tenant_id: session.tenant_id },
    });
    if (existing === null) {
      throw new NotFoundError('消息');
    }
    existing.content = '';
    existing.thinking_content = null;
    existing.usage = null;
    existing.tool_results = null;
    existing.status = 'streaming';
    await existing.save();
    return existing.id;
  }

  const created = await Message.create({
    session_id: session.id,
    tenant_id: session.tenant_id,
    role: 'assistant',
    content: '',
    status: 'streaming',
  });
  return created.id;
}

export interface FinalizePatch {
  content: string;
  thinking: string | null;
  dataParts: DataPartShape[];
  usage: MessageUsage | null;
  status: MessageStatus;
}

/**
 * 流结束后回填 assistant 消息。
 *
 * 重新生成（regenerate）走的是同一行（id 复用）—— 靠 generateId 让客户端看到的
 * message.id 始终等于 DB 主键，UI 上也就不会出现「同一个回答有两条」的鬼影。
 */
export async function finalizeAssistantMessage(id: string, patch: FinalizePatch): Promise<void> {
  await Message.update(
    {
      content: patch.content,
      thinking_content: patch.thinking,
      tool_results: patch.dataParts.length > 0 ? { data_parts: patch.dataParts } : null,
      usage: patch.usage,
      status: patch.status,
    },
    { where: { id } },
  );
}

/** 僵尸 streaming 行：进程崩了 / 被 kill 留下的。读历史时就地降级，顺手自愈。 */
const STALE_STREAMING_MS = 5 * 60 * 1000;

export async function markStaleStreamingAsFailed(sessionId: string): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_STREAMING_MS);
  await Message.update(
    { status: 'failed' },
    { where: { session_id: sessionId, status: 'streaming', created_at: { [Op.lt]: cutoff } } },
  );
}

/** 取会话历史（含刚插入的 user 行），按时间升序 */
export async function loadHistoryRows(sessionId: string, excludeIds: string[] = []): Promise<Message[]> {
  return Message.findAll({
    where: {
      session_id: sessionId,
      ...(excludeIds.length > 0 ? { id: { [Op.notIn]: excludeIds } } : {}),
    },
    order: [
      ['created_at', 'ASC'],
      ['id', 'ASC'],
    ],
  });
}

/**
 * 历史 → 喂给模型的 ModelMessage 序列。
 *
 * 只收 user 和 **complete** 的 assistant：
 *  - failed / cancelled 的半截回答喂回去会让模型接着错的内容编
 *  - streaming 的还在生成中，喂进去等于自己跟自己说话
 *
 * `ref` 带上行 id —— 摘要压缩（B1）靠它知道「摘要覆盖到哪条消息为止」。
 */
function historyToCountable(rows: readonly Message[]): TokenCountableMessage[] {
  const out: TokenCountableMessage[] = [];
  for (const row of rows) {
    if (row.role === 'user' && row.content !== null && row.content.trim() !== '') {
      out.push({ role: 'user', content: row.content, ref: row.id });
      continue;
    }
    if (row.role === 'assistant' && row.status === 'complete' && row.content !== null && row.content.trim() !== '') {
      out.push({ role: 'assistant', content: row.content, ref: row.id });
    }
  }
  return out;
}

// ============================================================
// data part 存取（见 MessageToolResults 注释里的语义重载约定）
// ============================================================

export function writeDataParts(parts: readonly DataPartShape[]): MessageToolResults | null {
  return parts.length > 0 ? { data_parts: [...parts] } : null;
}

export function readDataParts(row: Message): DataPartShape[] {
  const raw = row.tool_results;
  if (raw === null || typeof raw !== 'object') {
    return [];
  }
  const parts = (raw as MessageToolResults).data_parts;
  return Array.isArray(parts) ? parts : [];
}

/** 从 UIMessage 的 parts 里抽出可落库的 data part（只留 type + data） */
export function extractDataParts(parts: ChatUIMessage['parts']): DataPartShape[] {
  // 不用 SDK 的 isDataUIPart：它的类型谓词带泛参，在这个 union 上收窄不到
  return parts
    .filter((p): p is DataUIPart<ChatDataTypes> => p.type.startsWith('data-'))
    .map((p) => ({ type: p.type, data: p.data }));
}

/**
 * 一行 DB 记录 → 一个前端可渲染的 UIMessage。
 *
 * 渲染顺序：引用片段（data part）在前、正文在后 —— 前端角标区在气泡上方更自然。
 */
export function rowToUiMessage(row: Message): ChatUIMessage {
  const parts: ChatUIMessage['parts'] = [];

  for (const dp of readDataParts(row)) {
    parts.push({ type: dp.type, data: dp.data } as ChatUIMessage['parts'][number]);
  }
  if (row.thinking_content !== null && row.thinking_content !== '') {
    parts.push({ type: 'reasoning', text: row.thinking_content });
  }
  if (row.content !== null && row.content !== '') {
    parts.push({ type: 'text', text: row.content, state: 'done' });
  }
  return {
    id: row.id,
    role: row.role === 'assistant' ? 'assistant' : 'user',
    parts,
    // 消息创建时间 —— 前端在气泡右上角显示小时间戳（docs/04-b §4.2）
    metadata: { created_at: row.created_at.toISOString() },
  };
}

export async function loadSessionUiMessages(
  sessionId: string,
  limit: number,
): Promise<{ messages: ChatUIMessage[]; has_more: boolean }> {
  await markStaleStreamingAsFailed(sessionId);
  // 多取一条用来判断 has_more，省一次 COUNT
  const rows = await Message.findAll({
    where: { session_id: sessionId },
    order: [
      ['created_at', 'DESC'],
      ['id', 'DESC'],
    ],
    limit: limit + 1,
  });
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).reverse();
  return { messages: page.map(rowToUiMessage), has_more: hasMore };
}

// ============================================================
// 上下文窗口组装
// ============================================================

export interface ContextWindow {
  /** 喂给模型的 system 提示词（基础提示词 + 摘要段 + 记忆段 + 资料段） */
  systemText: string;
  /** 喂给模型的历史（已过轮数 + token 双重裁剪） */
  history: ModelMessage[];
  /** 留在资料段里的片段（编号 1..n） */
  hits: HybridHit[];
  /** 被裁掉的早期轮数 */
  droppedTurns: number;
  /**
   * 注入的会话摘要段（空串 = 这个会话还没有摘要）。
   *
   * 摘要段占的 token 从历史预算里扣 —— 跟检索片段、记忆段一样，
   * 三块都从「单轮上下文总预算」里划。
   */
  summaryBlock: string;
  /**
   * 这一轮被裁掉的**DB 行**（已排除「已经在摘要里」的部分）。
   *
   * 摘要压缩用它：把这些行折成一段摘要写进 sessions.summary。
   */
  droppedRows: Message[];
}

export interface BuildContextInput {
  tenantName: string;
  tenantSettings: Record<string, unknown> | null;
  /** 租户自定义提示词正文（docs/12-c §C3）；null = 用内置默认 */
  promptContent?: string | null;
  /** 租户覆盖的检索召回条数；null/undefined = 用进程级默认 */
  retrievalTopK?: number | null;
  /** 租户覆盖的历史轮数上限；null/undefined = 用进程级默认 */
  maxHistoryTurns?: number | null;
  /** 租户覆盖的检索片段 token 上限 */
  retrievalTokenBudget?: number | null;
  /** 租户覆盖的单轮上下文总预算 */
  contextTokenBudget?: number | null;
  /**
   * 租户覆盖的摘要段 token 上限；null/undefined = 用进程级默认。
   *
   * 跟检索预算、上下文总预算一样是**租户可配**的 —— 摘要压得越细，
   * 留给历史对话的预算越少。
   */
  summaryTokenBudget?: number | null;
  historyRows: readonly Message[];
  rawHits: readonly HybridHit[];
  /** 检索是否整体故障（两路全挂） */
  retrievalError: string | null;
  /**
   * 会话摘要状态（B1 摘要压缩）。
   *
   * 里面的 `boundary` 告诉调用方「摘要覆盖到哪条消息为止」——
   * 边界之前的历史已经被摘要概括了，不再喂原文。
   */
  summaryState?: SessionSummaryState | null;
  /**
   * 用户长期记忆段（B4）。
   * **由路由层在开流之前查好传进来** —— 跟 historyRows 同一个理由：
   * 查库失败要在还能返 500 的时候失败，塞进 execute 就只能变成流内 error 了。
   * 空串 = 这个用户没有记忆。
   */
  memoryText?: string | null;
}

/**
 * 组装一次 LLM 调用的全部输入：system 提示词 + 历史 + 资料段。
 *
 * 预算分配（先扣安全垫，再按固定比例切几块）：
 *   可用 = 总预算 × (1 - 安全垫)
 *   资料段 ≤ RETRIEVAL_TOKEN_BUDGET
 *   摘要段 ≤ SUMMARY_TOKEN_BUDGET
 *   记忆段 = 实际占用
 *   历史   = 可用 - 资料段实际占用 - 摘要段实际占用 - 记忆段实际占用 - SYSTEM_TOKEN_BUDGET
 *
 * 纯计算（除了提示词渲染），不触网 —— 单测可以直接喂假数据。
 */
export function buildContextWindow(input: BuildContextInput): ContextWindow {
  // 这四个都允许租户在「租户设置」里覆盖（docs/12-c §C4）；
  // 没配就走 .env 的 CHAT_*。安全垫始终用进程级 —— 那是估算误差余量，不是业务参数。
  const retrievalTopK = input.retrievalTopK ?? config.CHAT.RETRIEVAL_TOP_K;
  const maxHistoryTurns = input.maxHistoryTurns ?? config.CHAT.MAX_HISTORY_TURNS;
  const retrievalTokenBudget =
    input.retrievalTokenBudget ?? config.CHAT.RETRIEVAL_TOKEN_BUDGET;
  const contextTokenBudget = input.contextTokenBudget ?? config.CHAT.CONTEXT_TOKEN_BUDGET;
  const summaryTokenBudget =
    input.summaryTokenBudget ?? config.CHAT.SUMMARY_TOKEN_BUDGET;

  const reserve = Math.floor(contextTokenBudget * config.CHAT.BUDGET_SAFETY_RATIO);
  const usable = Math.max(1, contextTokenBudget - reserve);

  // 1) 检索片段：先按检索预算裁（RRF 结果已按相关度降序，装不下就丢后面的）
  const keptHits = fitHitsToBudget(input.rawHits, retrievalTokenBudget);
  const retrievalCost = estimateTokens(keptHits.map((h) => h.text).join('\n'));

  // 1.5) 会话摘要（B1 摘要压缩）：摘要段占的 token 从总预算里扣，
  //      跟检索片段、记忆段一样从历史预算里让位。
  const summaryState = input.summaryState ?? null;
  const summaryBlock = buildSummaryBlockText(summaryState?.summary ?? null, summaryTokenBudget);
  const summaryCost = estimateTokens(summaryBlock);

  // 1.6) 用户记忆（B4）：它的 token 从总预算里扣，跟检索片段一样从历史预算里让位。
  //     记忆不多的话这一项接近 0，不影响现有行为。
  const memoryText = input.memoryText ?? '';
  const memoryCost = estimateTokens(memoryText);

  // 2) 历史：先把「已经在摘要里」的部分切掉，剩下的才参与预算裁剪。
  //    否则摘要覆盖的旧对话会被当成新增内容再喂一遍 —— 既浪费 token，
  //    又会让模型看到同一件事的两种说法（原文 + 摘要）。
  const freshRows = splitHistoryByBoundary(
    input.historyRows,
    summaryState?.boundary ?? null,
  ).fresh;

  // 3) 历史：剩余预算里从最新一轮往回收
  const historyBudget = Math.max(
    0,
    usable - retrievalCost - summaryCost - memoryCost - config.CHAT.SYSTEM_TOKEN_BUDGET,
  );
  const countable = historyToCountable(freshRows);
  const fitted = fitHistoryToBudget(countable, {
    maxTokens: historyBudget,
    maxTurns: maxHistoryTurns,
  });

  if (fitted.droppedTurns > 0) {
    logger.info(
      { droppedTurns: fitted.droppedTurns, keptTokens: fitted.estimatedTokens, summaryCost },
      '历史超出 token 预算，已裁掉更早的轮次（会被折进会话摘要，下一轮生效）',
    );
  }

  // 4) 提示词：租户自定义正文优先，编号由 renderRagContext 分配（和 data-citations 同源）
  const prompt = buildPrompt({
    tenantName: input.tenantName,
    settings: input.tenantSettings,
    overrideContent: input.promptContent ?? null,
    summaryText: summaryBlock,
    memoryText,
    hits: keptHits,
    // 没命中时给模型一句明话，避免它凭印象编；
    // 检索整体故障时用另一句措辞，用户能从 UI 上看出是系统问题
    emptyNotice: input.retrievalError ?? NO_HITS_NOTICE,
    systemTokenBudget: config.CHAT.SYSTEM_TOKEN_BUDGET,
  });

  const history: ModelMessage[] = fitted.kept.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
  }));

  // 被裁掉的那些轮次对应的 DB 行 —— 摘要压缩要拿它们去调 LLM 摘要
  const rowById = new Map(freshRows.map((r) => [r.id, r]));
  const droppedRows: Message[] = [];
  for (const m of fitted.dropped) {
    if (m.ref === undefined) {
      continue;
    }
    const row = rowById.get(m.ref);
    if (row !== undefined) {
      droppedRows.push(row);
    }
  }

  return {
    systemText: prompt.systemText,
    history,
    hits: keptHits,
    droppedTurns: fitted.droppedTurns,
    summaryBlock,
    droppedRows,
  };
}

// ============================================================
// 流式执行
// ============================================================

/** 客户端发来的请求体（AI SDK 的 HttpChatTransport 协议） */
export interface ChatRequestBody {
  messages?: ChatUIMessage[];
  [key: string]: unknown;
}

export interface ParsedRequest {
  /** 本轮用户输入（重新生成时取倒数第二条 user） */
  userText: string;
  /** 是否是「重新生成」：客户端数组最后一条是 assistant */
  isRegenerate: boolean;
  /** 重新生成时被覆盖的那条 assistant 的 id */
  regenerateTargetId: string | null;
}

/**
 * 从客户端请求体里解析出「这轮要问什么」。
 *
 * **不信任客户端发来的完整历史** —— 只取最后一条 user 的正文，
 * 真正喂给模型的上下文一律从 DB 重建。否则一个登录用户可以把
 * `messages` 伪造成任意内容（塞 system 消息、塞别的租户的内容）来套 prompt。
 */
export function parseChatRequest(body: ChatRequestBody, maxInputChars?: number): ParsedRequest {
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ValidationError('请求体缺少 messages');
  }
  const last = messages[messages.length - 1];
  if (last === undefined) {
    throw new ValidationError('请求体缺少 messages');
  }

  const isRegenerate = last.role === 'assistant';
  const target = isRegenerate ? messages[messages.length - 2] : last;
  if (target === undefined || target.role !== 'user') {
    throw new ValidationError('最后一条消息必须是用户消息（或「用户 + 助手」成对出现）');
  }

  const userText = textOfUiMessage(target);
  if (userText.trim() === '') {
    throw new ValidationError('消息内容为空');
  }
  // 上限来自租户设置（可覆盖）；不传时回落到 .env —— 调用方（路由）会把租户值传进来
  const limit = maxInputChars ?? config.CHAT.MAX_INPUT_CHARS;
  if (userText.length > limit) {
    throw new ValidationError(`单条消息超过 ${limit} 字`);
  }

  return {
    userText,
    isRegenerate,
    regenerateTargetId: isRegenerate ? last.id : null,
  };
}

/** UIMessage → 纯文本（只取 text part，data / reasoning 不算用户输入） */
export function textOfUiMessage(message: ChatUIMessage): string {
  return message.parts
    .filter(isTextUIPart)
    .map((p) => p.text)
    .join('\n');
}

export interface StreamContext {
  session: Session;
  tenantName: string;
  tenantSettings: Record<string, unknown> | null;
  assistantRowId: string;
  userText: string;
  /**
   * 历史消息行 —— **由路由层在开流之前查好传进来**。
   * 查库失败要在还能返 500 的时候失败；塞进 execute 就只能变成流内 error 了。
   */
  historyRows: Message[];
  /** 租户级 LLM 配置（docs/12-c §C4）：模型 / 温度 / 输出上限 / 缓存开关 */
  llm: ResolvedLlmSettings;
  /** 租户生效的提示词正文（docs/12-c §C3）；null = 用内置默认 */
  promptContent: string | null;
  /** 客户端 IP（写审计日志用） */
  ip?: string | null;
  /**
   * 用户长期记忆段（B4）—— **由路由层在开流之前查好传进来**。
   * 跟 historyRows 同一个理由：查库失败要在还能返 500 的时候失败。
   * 空串 = 没有记忆。
   */
  memoryText?: string | null;
  /**
   * 会话摘要状态（B1 摘要压缩）—— **由路由层在开流之前查好传进来**。
   *
   * 摘要正文 + 摘要覆盖到哪条消息为止（边界）。
   * 边界之前的历史已经被摘要概括，不再喂原文。
   */
  summaryState?: SessionSummaryState | null;
  /** 租户覆盖的摘要段 token 上限；null/undefined = 用进程级默认 */
  summaryTokenBudget?: number | null;
  /**
   * 观测句柄（D2）。路由层创建、这里消费：
   * 检索 / 调模型 / 记账三段各自记成 span，流结束时把 trace 收掉。
   * 不传 = 不采集（单测直接调 createChatStream 时就是这种情况）。
   */
  trace?: TraceHandle | undefined;
}

/**
 * 跑一次流式回答，返回 UI message stream。
 *
 * 调用方负责把它 pipe 到响应上；execute 里的一切失败都通过 onError 变成流内 error part。
 */
export function createChatStream(ctxData: StreamContext) {
  const { session, tenantName, tenantSettings, assistantRowId, userText, historyRows, llm } =
    ctxData;

  // execute 外部作用域：streamText 的 usage 要在 onEnd 里取。
  // 用对象包一层而不是裸 let —— 赋值发生在回调里，TS 的控制流分析会把裸变量
  // 在 onEnd 处误判成初始值（null），直接 optional chain 会报 never。
  const generation: { usage: PromiseLike<LanguageModelUsage> | null } = { usage: null };

  // 输出审核结果：execute 里判出来，onEnd 里用来决定「落什么进 messages」。
  // 同样用对象包一层，理由同上。
  const moderation: { blocked: boolean; reason: string | null } = {
    blocked: false,
    reason: null,
  };

  // ---- 熔断（D5）----
  //
  // 按端点分桶：某个租户自己的 LLM 端点挂了只断它自己，平台默认端点挂了
  // 所有用它的租户一起断（上游确实是同一个）。
  const breaker = config.CIRCUIT_BREAKER.ENABLED
    ? getBreaker(`${llm.provider}|${llm.baseUrl}`)
    : null;
  // 短路标记：熔断期间我们**没有真的打上游**，不能记成一次失败 ——
  // 否则每被短路一次就刷新一次冷却期，熔断永远恢复不了。
  const breakerState: { shortCircuited: boolean } = { shortCircuited: false };

  // LLM 调用的 span（D2）：execute 里开、onEnd 里关。
  // 生成是流式的，execute 返回时模型可能还在吐字 —— 真正的耗时要等到
  // usage promise resolve，所以不能在 execute 里就 end。
  const llmSpanHolder: { span: SpanHandle | null | undefined } = { span: null };

  const guardActor: GuardActor = {
    tenantId: session.tenant_id,
    userId: session.user_id,
    llm: { apiKey: llm.apiKey, baseUrl: llm.baseUrl, model: llm.model },
    ip: ctxData.ip ?? null,
  };

  return createUIMessageStream<ChatUIMessage>({
    // 客户端看到的 message.id === messages 表主键（重新生成时也是同一条）
    generateId: () => assistantRowId,
    onError: (err: unknown) => {
      // 熔断是「上游在恢复中」，跟「这轮生成失败了」不是一回事 ——
      // 给用户一句能照着做的提示（稍后重试），别让他以为是自己的问题
      if (err instanceof CircuitOpenError) {
        logger.warn({ sessionId: session.id }, 'LLM 端点熔断中，本次请求快速失败');
        return '服务暂时不可用，正在恢复中，请稍后再试。';
      }
      logger.error(
        { err: err instanceof Error ? err.message : String(err), sessionId: session.id },
        '对话流内错误',
      );
      // 绝不把内部错误信息透给客户端
      return '回答生成失败，请稍后重试。';
    },
    execute: async ({ writer }: { writer: UIMessageStreamWriterWithOutcome<ChatUIMessage> }) => {
      // ---- 检索阶段（唯一的长延迟，先让前端看见状态）----
      // 心跳类 part 一律 transient：只在 onData 回调里用一次，不进 message.parts、
      // 也不落库 —— 否则每条消息的 parts 里都会堆两段没用的过程数据。
      writer.write({
        type: 'data-status',
        transient: true,
        data: { phase: 'retrieving', message: '正在检索知识库…' },
      });

      const failedSources = new Set<RecallSource>();
      let recallError: unknown = null;
      const startedAt = Date.now();
      let rawHits: HybridHit[] = [];

      // ---- 查询改写（B2 · 可选）----
      //
      // 「我入职三个月能休几天年假」→「年假 天数 入职时长 满1年不满10年」
      // 改写失败一律回落原查询（不让它拖住检索）。
      let searchQuery = userText;
      let rewritten: string | null = null;
      if (llm.queryRewriteEnabled) {
        const r = await rewriteQuery({
          query: userText,
          apiKey: llm.apiKey,
          baseUrl: llm.baseUrl,
          model: llm.model,
          timeoutMs: QUERY_REWRITE_TIMEOUT_MS,
        });
        searchQuery = r.effectiveQuery;
        rewritten = r.rewritten;
      }

      const retrievalSpan = ctxData.trace?.span('retrieval.search', 'retrieval', {
        query_chars: userText.length,
        // 改写后的查询字数 + 改写是否成功 —— 排查「为什么没召回到」时要看这个
        ...(rewritten !== null
          ? { rewritten_query_chars: searchQuery.length, query_rewritten: true }
          : { query_rewritten: false }),
      });
      try {
        rawHits = await hybridSearch({
          query: searchQuery,
          tenantId: session.tenant_id,
          topK: llm.retrievalTopK,
          // 租户可以在后台关掉自己的重排（docs/12-c §C4）
          rerankEnabled: llm.rerankEnabled,
          onRecallFailure: (source, err) => {
            failedSources.add(source);
            recallError ??= err;
          },
        });
      } catch (err: unknown) {
        // hybridSearch 内部两路各自兜底，正常不会走到这；兜底再兜一层
        recallError = err;
      }
      const tookMs = Date.now() - startedAt;
      // 重排有没有真的生效（降级时是 false）：管理员在观测里一眼能看出
      // 「这次排序是重排给的」还是「重排挂了退回了 RRF」
      const rerankApplied = rawHits.some((h) => h.rerank_score !== null);
      if (recallError !== null) {
        retrievalSpan?.fail(recallError, {
          hit_count: rawHits.length,
          took_ms: tookMs,
          rerank_applied: rerankApplied,
        });
      } else {
        retrievalSpan?.end({
          hit_count: rawHits.length,
          took_ms: tookMs,
          failed_sources: [...failedSources],
          rerank_applied: rerankApplied,
        });
      }

      // 两路全挂 = 检索层故障；只挂一路 = 降级可用，答案仍然可用，不打扰用户
      const bothDown = failedSources.size >= 2;
      const retrievalError =
        bothDown && rawHits.length === 0
          ? '知识库检索暂时不可用，本次回答没有使用参考资料。'
          : null;
      if (bothDown) {
        logger.error(
          { sessionId: session.id, tenantId: session.tenant_id },
          '两路召回全部失败，本次回答降级为无资料',
        );
      }

      // ---- 组装上下文 ----
      const window = buildContextWindow({
        tenantName,
        tenantSettings,
        promptContent: ctxData.promptContent,
        retrievalTopK: llm.retrievalTopK,
        maxHistoryTurns: llm.maxHistoryTurns,
        retrievalTokenBudget: llm.retrievalTokenBudget,
        contextTokenBudget: llm.contextTokenBudget,
        summaryTokenBudget: ctxData.summaryTokenBudget ?? null,
        historyRows,
        rawHits,
        retrievalError,
        summaryState: ctxData.summaryState ?? null,
        memoryText: ctxData.memoryText ?? '',
      });

      // 引用片段**必须带 id**：AI SDK 客户端对 data part 的去重只在 `chunk.id != null`
      // 时生效（见 ai 的 processUIMessageStream：没有 id 就每次 parts.push）。
      // 固定 id 让同一个 part 重复到达时变成「覆盖」而不是「追加」。
      // 这个 part 不能 transient —— 刷新页面后的历史回答要靠它渲染来源角标。
      writer.write({
        type: 'data-citations',
        id: 'citations',
        data: {
          // 编号与 system prompt 里的 [n] 严格一致（同一函数产出）
          hits: window.hits.map((h, i) => ({
            index: i + 1,
            doc_id: h.doc_id,
            chunk_index: h.chunk_index,
            source: h.source,
            score: Number(h.score.toFixed(4)),
            text: h.text.slice(0, 500),
            sources: h.sources,
          })),
          retrieved: window.hits.length > 0,
          took_ms: tookMs,
          ...(retrievalError === null ? {} : { retrieval_error: retrievalError }),
        },
      });

      if (window.droppedTurns > 0) {
        writer.write({
          type: 'data-truncated',
          transient: true,
          data: {
            dropped_turns: window.droppedTurns,
            // 开了摘要压缩就说清楚「不是丢掉，是压成摘要」——
            // 用户看到的措辞不一样，对「AI 还记不记得」的预期就差很多。
            //
            // ⚠️ 判断的是「摘要功能开不开」，不是「有没有现成的摘要」：
            //    第一轮压缩时摘要还不存在，但用户听到的应该是「正在整理成摘要」，
            //    而不是「已省略」—— 那样用户会以为内容丢了。
            message:
              llm.summaryEnabled
                ? `更早的 ${window.droppedTurns} 轮对话超出上下文预算，正在整理成摘要（下一轮起会带上）`
                : `已省略更早的 ${window.droppedTurns} 轮对话（超出模型上下文预算）`,
            summarized: llm.summaryEnabled,
          },
        });
      }

      // ---- 摘要压缩（B1）----
      //
      // 这一轮被裁掉的轮次 → 调 LLM 折成一段摘要写进 sessions.summary，
      // 下一轮再注入上下文。
      //
      // ⚠️ **必须 fire-and-forget**：这是在流的 execute 里，不能 await ——
      //    一次摘要调用要几秒，await 会把首字节响应拖到几秒之后。
      //    摘要滞后一轮是可接受的（见 src/services/session-summary.ts 的说明）。
      if (window.droppedRows.length > 0) {
        void summarizeDroppedTurns({
          tenantId: session.tenant_id,
          userId: session.user_id,
          sessionId: session.id,
          droppedRows: window.droppedRows,
          fallbackLlm: llm,
        }).catch((err: unknown) => {
          logger.error(
            { err: err instanceof Error ? err.message : String(err), sessionId: session.id },
            '会话摘要任务失败',
          );
        });
      }

      // ---- 生成阶段 ----
      writer.write({
        type: 'data-status',
        transient: true,
        data: { phase: 'generating', message: '正在组织回答…' },
      });

      // 凭据 / 模型 / 温度全部来自租户配置（docs/12-c §C4），没配的项回落 .env。
      // getLlm() 的兜底校验已经在路由层做过（缺凭据会在开流前报出来）
      const anthropic = createAnthropic({ apiKey: llm.apiKey, baseURL: llm.baseUrl });

      // 系统提示词走 `system` 参数（不能塞进 messages 的 system 角色）——
      // 智谱等 Anthropic 兼容网关会拒收 messages 里的 system 角色，报
      // 「System messages are not allowed in the prompt or messages fields」。
      // SDK 把 system 参数映射成 Anthropic 协议的 instructions 字段。
      //
      // 传对象而不是字符串，是为了给提示词挂 cacheControl（docs/12-b §B1 欠的那项）：
      // 只有挂在 message 上才能带 providerOptions。
      const systemMessage: SystemModelMessage = llm.promptCacheEnabled
        ? {
            role: 'system',
            content: window.systemText,
            providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' as const } } },
          }
        : { role: 'system', content: window.systemText };

      // ---- 熔断（D5）----
      //
      // 上游连着挂的时候别再往里冲：直接快速失败，用户立刻拿到提示，
      // 而不是干等一次超时（默认 30 秒起步）。
      // 半开状态下只放一个探活请求过去，其余照样快速失败 ——
      // 冷却期一过就放行一批的话，等于又来一次洪峰。
      if (breaker !== null && !breaker.allowRequest()) {
        breakerState.shortCircuited = true;
        throw new CircuitOpenError(`${llm.provider}|${llm.baseUrl}`);
      }

      const result = streamText({
        model: anthropic(llm.model),
        system: systemMessage,
        messages: window.history,
        temperature: llm.temperature,
        maxOutputTokens: llm.maxOutputTokens,
        // 思考模式：默认关闭（budget=0）。各 provider 对 thinking 参数的支持程度不同，
        // 打开前先在目标 provider 上验一轮（docs/06 §6.4）
        ...(llm.thinkingBudgetTokens > 0
          ? {
              providerOptions: {
                anthropic: {
                  thinking: {
                    type: 'enabled' as const,
                    budgetTokens: llm.thinkingBudgetTokens,
                  },
                },
              },
            }
          : {}),
      });
      generation.usage = result.usage;
      // LLM span 到 onEnd 里再关（流式生成真正结束才知道耗时和 token）
      llmSpanHolder.span = ctxData.trace?.span('llm.generate', 'llm', {
        provider: llm.provider,
        model: llm.model,
        system_chars: window.systemText.length,
        history_turns: window.history.length,
        retrieved: window.hits.length,
      });

      writer.merge(toUIMessageStream({ stream: result.stream, sendReasoning: true }));

      // ---- 输出审核（D4）----
      //
      // ⚠️ SSE 的固有约束：正文已经逐字发给浏览器了，收不回来。
      //    这一层能做到的是「不把原文落进 messages + 通知前端把气泡换成拦截文案」。
      //
      // result.text 和 result.stream 可以同时用（SDK 内部把流 tee 成两份，
      // 一份给 merge、一份给 text 的累积），但客户端断连时 text 可能永远
      // 不 resolve —— 所以套一层超时，判不出来就放行。
      const fullText = await withTimeout(result.text, config.SECURITY.GUARD_TIMEOUT_MS, '');
      if (fullText.trim() !== '') {
        const verdict = await guardAssistantOutput(fullText, guardActor);
        if (verdict.blocked) {
          moderation.blocked = true;
          moderation.reason = verdict.reason;
          writer.write({
            type: 'data-moderation',
            id: 'moderation',
            data: { blocked: true, reason: verdict.reason ?? '内容违规' },
          });
        }
      }

      writer.setOutcome({ status: 'completed' });
    },
    // onEnd 在 flush 和 cancel 时都会触发：断连 / 中止 / 失败都有官方信号，
    // 落库状态不用靠猜
    onEnd: async ({ responseMessage, outcome, isAborted, isCancelled }) => {
      const parts = responseMessage.parts;
      const content = parts.filter(isTextUIPart).map((p) => p.text).join('');
      const thinking = parts.filter(isReasoningUIPart).map((p) => p.text).join('');

      let usage: MessageUsage | null = null;
      const pending: PromiseLike<LanguageModelUsage> | null = generation.usage;
      if (pending !== null) {
        try {
          const u = await pending;
          usage = {
            input_tokens: u.inputTokens ?? 0,
            output_tokens: u.outputTokens ?? 0,
            cache_read_tokens: u.inputTokenDetails.cacheReadTokens ?? 0,
            cache_write_tokens: u.inputTokenDetails.cacheWriteTokens ?? 0,
          };
        } catch {
          // usage 取不到不影响正文，落个 null 就行
        }
      }

      let status: MessageStatus;
      if (outcome.status === 'failed') {
        status = 'failed';
      } else if (isAborted || outcome.status === 'aborted' || isCancelled === true) {
        status = 'cancelled';
      } else if (content.trim() === '') {
        status = 'failed';
      } else {
        status = 'complete';
      }

      // ---- 熔断记账（D5）----
      //
      // 只记「真的打了上游」的请求：
      //  - 被短路的那次没发出去，记失败会无限刷新冷却期
      //  - 用户自己断开（cancelled）不算上游故障
      if (breaker !== null && !breakerState.shortCircuited) {
        if (status === 'failed') {
          breaker.recordFailure();
          if (breaker.state === 'open') {
            logger.warn(
              { provider: llm.provider, baseUrl: llm.baseUrl, sessionId: session.id },
              'LLM 端点连续失败，熔断已打开',
            );
          }
        } else if (status === 'complete') {
          breaker.recordSuccess();
        }
      }

      // 输出审核拦下时：**原文不落库**，只留一句拦截文案。
      // （前端已经看到流出来的字节了，靠 data-moderation part 换成这段文案）
      const finalContent = moderation.blocked ? OUTPUT_BLOCKED_TEXT : content;

      // ⚠️ 这里绝不能 throw：onEnd 是在流的 flush/cancel 里被 await 的，
      // 抛出去会让已经写了一半的响应出问题。失败就记日志，让这行停在 streaming
      // （下次读历史时会被 markStaleStreamingAsFailed 自愈成 failed）。
      try {
        await finalizeAssistantMessage(assistantRowId, {
          content: finalContent,
          thinking: thinking === '' ? null : thinking,
          dataParts: extractDataParts(parts),
          usage,
          status,
        });
      } catch (err: unknown) {
        logger.error(
          { err: err instanceof Error ? err.message : String(err), assistantRowId },
          '回填 assistant 消息失败',
        );
      }

      // LLM span 收尾（D2）：流真正结束才知道耗时和 token，所以放在 onEnd
      const llmSpan = llmSpanHolder.span;
      if (llmSpan !== null && llmSpan !== undefined) {
        const spanUsage = {
          input_tokens: usage?.input_tokens ?? 0,
          output_tokens: usage?.output_tokens ?? 0,
          cache_read_tokens: usage?.cache_read_tokens ?? 0,
          cache_write_tokens: usage?.cache_write_tokens ?? 0,
        };
        if (status === 'failed') {
          llmSpan.fail(new Error('模型生成失败'), spanUsage);
        } else {
          llmSpan.end(spanUsage);
        }
      }

      // ---- 成本记账（D3）----
      // 放在最后：即使落库失败也要把账记上（反过来不行 —— 没生成内容就不该计费）。
      let estimatedCost = 0;
      if (config.COST.TRACKING_ENABLED && usage !== null) {
        const costSpan = ctxData.trace?.span('cost.record', 'cost');
        try {
          estimatedCost = await recordLlmUsage({
            tenantId: session.tenant_id,
            userId: session.user_id,
            sessionId: session.id,
            messageId: assistantRowId,
            provider: llm.provider,
            model: llm.model,
            usage: {
              input_tokens: usage.input_tokens ?? 0,
              output_tokens: usage.output_tokens ?? 0,
              cache_read_tokens: usage.cache_read_tokens ?? 0,
              cache_write_tokens: usage.cache_write_tokens ?? 0,
            },
          });
          costSpan?.end({ cost_usd: estimatedCost });

          // 超预算 → 写审计告警（后台顶栏能看到）
          const budgetRaw = await getSettingValue(session.tenant_id, 'monthly_token_budget');
          const budget = typeof budgetRaw === 'number' ? budgetRaw : 0;
          if (budget > 0) {
            await checkBudgetAndAlert(session.tenant_id, budget);
          }
        } catch (err: unknown) {
          costSpan?.fail(err);
          logger.error(
            { err: err instanceof Error ? err.message : String(err), sessionId: session.id },
            '成本记账失败',
          );
        }
      }

      // ---- trace 收尾（D2）----
      // 「cancelled」（客户端断开）不算错误 —— 那是用户自己关掉了页面，
      // 算进错误率会让指标失真。只有真的失败才算 error。
      if (ctxData.trace !== undefined) {
        const totalTokens =
          usage === null
            ? 0
            : (usage.input_tokens ?? 0) +
              (usage.output_tokens ?? 0) +
              (usage.cache_read_tokens ?? 0) +
              (usage.cache_write_tokens ?? 0);
        try {
          await ctxData.trace.end({
            status: status === 'failed' ? 'error' : 'success',
            provider: llm.provider,
            model: llm.model,
            usage:
              usage === null
                ? null
                : {
                    input_tokens: usage.input_tokens ?? 0,
                    output_tokens: usage.output_tokens ?? 0,
                    cache_read_tokens: usage.cache_read_tokens ?? 0,
                    cache_write_tokens: usage.cache_write_tokens ?? 0,
                    total_tokens: totalTokens,
                    cost: estimatedCost,
                  },
            metadata: {
              message_id: assistantRowId,
              message_status: status,
              moderation_blocked: moderation.blocked,
            },
          });
        } catch (err: unknown) {
          logger.error(
            { err: err instanceof Error ? err.message : String(err), sessionId: session.id },
            'trace 收尾失败',
          );
        }
      }

      // ---- 记忆抽取（B4 · 长期记忆）----
      //
      // ⚠️ **必须 fire-and-forget**：onEnd 是在流的 flush / cancel 里被 await 的，
      //    在这里 await 一次 LLM 调用会把整个响应的收尾拖慢好几秒。
      //    代价是「刚说完就立刻追问」时新记忆还来不及进下一轮 —— 可以接受，
      //    而且下一轮的记忆是「上一轮之前」的，也不算错。
      //
      // 只在对话正常完成时抽：被中止 / 失败的那一轮，用户的话可能是说了又后悔。
      //
      // ⚠️ ctxData.userText 是**脱敏之后**的文本（路由层 guard 过），
      //    所以记忆里不会出现明文身份证 / 银行卡号。
      if (status === 'complete' && session.user_id !== null) {
        void extractAndApplyMemories({
          tenantId: session.tenant_id,
          userId: session.user_id,
          userText: ctxData.userText,
          assistantText: finalContent,
          sessionId: session.id,
          messageId: assistantRowId,
          // 只是兜底：抽取优先用租户单独配的「记忆抽取模型」，
          // 没配才回落到对话模型（resolveExtractionLlm 内部处理）
          fallbackLlm: llm,
        }).catch((err: unknown) => {
          logger.error(
            { err: err instanceof Error ? err.message : String(err), sessionId: session.id },
            '记忆抽取任务失败',
          );
        });
      }
    },
  });
}