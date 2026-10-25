import { generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { Session } from '../models';
import type { Message } from '../models/Message';
import type { SessionMetadata } from '../models/Session';
import { logger } from '../logger';
import { withRetry } from '../lib/retry';
import { config } from '../config';
import { estimateTokens } from '../lib/token-estimate';
import { maskPiiText, scanInjectionRules } from '../lib/security';
import {
  renderSummaryBlock,
  SUMMARY_BLOCK_HEADER,
} from '@shared/prompts/chat/summary';
import { buildSummarySystemPrompt, renderSummaryInput, type SummaryTurn } from '../prompts/summary';
import { recordLlmUsage } from './cost-tracking';
import { getSettingValue } from './tenant-settings';
import { resolveSummaryLlm, type ResolvedLlmSettings } from './llm-settings';
import { startTrace, type TraceHandle } from './trace';

/**
 * 会话摘要服务 —— B1 摘要压缩（docs/12-b-需求-ai对话能力.md §B1）
 *
 * ## 它解决什么
 * 超长会话超出上下文预算时，老做法是**直接丢掉更早的轮次**（用户能感知到 AI 忘事）。
 * 摘要压缩把丢掉的轮次折成一段摘要写进 `sessions.summary`，下一轮再喂回上下文 ——
 * 体验上从「AI 失忆」变成「AI 记得压缩版的早期对话」。
 *
 * ## 边界标记（metadata.summary_boundary）
 * 摘要要覆盖哪些消息，必须能说清楚 —— 否则下一轮分不清「哪些已经在摘要里、
 * 哪些是新增的」，就会重复摘要或者漏摘要。
 *
 * 边界存在 `sessions.metadata`（JSON 列）里，值是 `{message_id, created_at}`：
 * 摘要覆盖到哪一条消息为止。下一轮按这个标记把历史切成两段：
 *   - 边界之前 → 已经在摘要里，不再喂原文
 *   - 边界之后 → 新增部分，正常参与预算裁剪
 *
 * ## 为什么摘要滞后一轮
 * 摘要是**异步**做的（fire-and-forget），不阻塞用户这一轮的回答：
 * 本轮发现「有轮次被丢掉」→ 结束后才去调 LLM 摘要 → 写进库 → 下一轮注入。
 *
 * 代价是：被丢掉的那几轮，要到下一轮才进摘要。本轮它们确实不在上下文里
 * （跟老的截断行为一样），UI 上照实告诉用户。
 *
 * ## 滚动重写
 * 每次摘要的输入是「旧摘要 + 新丢掉的轮次」，输出是**一份全新的完整摘要**。
 * 不是往摘要后面追加 —— 追加的话摘要会无限增长，很快就撑爆预算。
 */

// ============================================================
// 纯逻辑：边界标记
// ============================================================

/**
 * 摘要覆盖到哪里了。
 *
 * 存两个字段而不是只存 message_id：万一那条消息被删了（会话整体删是另一回事），
 * 还能按时间戳兜底切一刀。只存 id 的话边界就永远找不回来了。
 */
export interface SummaryBoundary {
  /** 摘要覆盖到的最后一条消息 id */
  message_id: string;
  /** 那条消息的创建时间（ISO 字符串） */
  created_at: string;
}

/** metadata 里存边界用的键 */
const BOUNDARY_KEY = 'summary_boundary';

function isSummaryBoundary(value: unknown): value is SummaryBoundary {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return typeof v.message_id === 'string' && typeof v.created_at === 'string';
}

/** 从 sessions.metadata 里读边界；没有 / 格式不对 → null（当作「还没摘要过」） */
export function readSummaryBoundary(metadata: SessionMetadata | null): SummaryBoundary | null {
  if (metadata === null || typeof metadata !== 'object') {
    return null;
  }
  const raw = (metadata as Record<string, unknown>)[BOUNDARY_KEY];
  return isSummaryBoundary(raw) ? raw : null;
}

/** 写边界（保留 metadata 里的其他键） */
export function writeSummaryBoundary(
  metadata: SessionMetadata | null,
  boundary: SummaryBoundary,
): SessionMetadata {
  const base: SessionMetadata =
    metadata !== null && typeof metadata === 'object' ? { ...metadata } : {};
  return { ...base, [BOUNDARY_KEY]: boundary };
}

/** 有 id / created_at 的最小形状（DB 行 / 单测假数据都能喂） */
export interface BoundaryRow {
  id: string;
  created_at: Date;
}

/**
 * 按边界把历史切成「已进摘要」和「新增」两段。
 *
 * ## 为什么先按 id 找下标，而不是直接比时间戳
 * 排序是 `(created_at ASC, id ASC)`，而 `created_at` 是 DATE(6)（微秒）——
 * 两条消息可能落在同一毫秒里。JS 的 Date 只有毫秒精度，直接比时间戳会误判。
 * 按 id 找下标拿到的是**精确的切点**，跟 SQL 的排序完全一致。
 *
 * 边界行找不到时（理论上不会发生：消息不会被单独删）才退回时间戳兜底。
 */
export function splitHistoryByBoundary<T extends BoundaryRow>(
  rows: readonly T[],
  boundary: SummaryBoundary | null,
): { covered: T[]; fresh: T[] } {
  if (boundary === null) {
    return { covered: [], fresh: [...rows] };
  }
  const idx = rows.findIndex((r) => r.id === boundary.message_id);
  if (idx >= 0) {
    return { covered: rows.slice(0, idx + 1), fresh: rows.slice(idx + 1) };
  }
  // 兜底：边界行不在了 → 按时间戳切（可能把边界那一毫秒的消息也算进新增，无伤大雅）
  const ts = Date.parse(boundary.created_at);
  if (Number.isNaN(ts)) {
    return { covered: [], fresh: [...rows] };
  }
  let cut = rows.length;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row !== undefined && row.created_at.getTime() > ts) {
      cut = i;
      break;
    }
  }
  return { covered: rows.slice(0, cut), fresh: rows.slice(cut) };
}

// ============================================================
// 纯逻辑：摘要正文处理
// ============================================================

/**
 * 摘要正文里**不能出现**的东西。
 *
 * 摘要会被原样拼进 system prompt（见 renderSummaryBlock），所以：
 *  - Markdown 标题 → 能伪造 system prompt 的段落结构
 *  - `[1]` → 能伪造引用编号。模型在答案里标 `[1]`，前端把它映射到真实的第一篇文档，
 *    答案和引用卡片就对不上了，而 UI 上完全看不出来
 *  - 「来源：」 → 能伪造引用条目的格式
 *
 * 这跟记忆正文的三道检查（src/services/memory.ts 的 sanitizeMemoryContent）是同一套理由。
 */
const SUMMARY_FORBIDDEN_PATTERN = /^\s{0,3}#{1,6}\s|来源[:：]|\[\s*\d+\s*\]/m;

/**
 * 摘要正文清洗 —— 跟记忆的差别是「清洗」而不是「拒绝」。
 *
 * 记忆是用户手写的，内容不对就拒（用户会知道哪条被拒了）。
 * 摘要是模型自动生成的，内容不对只能洗 —— 整段丢掉的话那一轮对话的记忆就没了。
 * 所以这里是**移除危险片段**而不是抛错。
 */
export function sanitizeSummaryText(text: string): string {
  let out = text.trim();
  // 代码围栏：模型偶尔会包 ```，进了 system prompt 会显得很怪
  out = out.replace(/^```[a-zA-Z]*\n?/gm, '').replace(/```$/gm, '');
  // 标题行：整行去掉（标题下面的正文留着）
  out = out
    .split('\n')
    .filter((line) => !/^\s{0,3}#{1,6}\s/.test(line))
    .join('\n');
  // 方括号编号：[1] → （1）
  out = out.replace(/\[\s*(\d+)\s*\]/g, '（$1）');
  // 「来源：xxx」整行去掉
  out = out
    .split('\n')
    .filter((line) => !/^\s*来源[:：]/.test(line))
    .join('\n');
  // 连续空行压成一行
  out = out.replace(/\n{3,}/g, '\n\n').trim();
  return out;
}

/** 摘要正文里还有没有危险结构（清洗之后复查一遍） */
export function summaryHasForbiddenStructure(text: string): boolean {
  return SUMMARY_FORBIDDEN_PATTERN.test(text);
}

/**
 * 按 token 预算截断文本。
 *
 * 估算是「故意高估」的（见 src/lib/token-estimate.ts），这里按**全中文**的比例切
 * （中文 1 字 ≈ 1.5 token；英文 4 字符 ≈ 1 token，用中文比例切英文会切得更短，
 * 宁可少留也不要超预算）。
 */
export function truncateToTokenBudget(text: string, budget: number): string {
  if (budget <= 0) {
    return '';
  }
  if (estimateTokens(text) <= budget) {
    return text;
  }
  const maxChars = Math.max(0, Math.floor(budget / 1.5));
  let cut = text.slice(0, maxChars);
  // 尽量切在行边界（后半段还有换行的话），免得摘要末尾断在半句话上
  const lastBreak = cut.lastIndexOf('\n');
  if (lastBreak > 0 && lastBreak > maxChars * 0.6) {
    cut = cut.slice(0, lastBreak);
  }
  return cut.trim();
}

/**
 * 摘要段的固定说明占多少 token。
 *
 * **实测，不拍常数**：说明文字改了（加一句话 / 少一句话），
 * 拍出来的常数就会失准 —— 表现是「预算设 600，实际超了 70 token」，
 * 而超预算的后果是 provider 侧 400（流已经开了，只能给用户一个流内 error）。
 */
const SUMMARY_HEADER_COST = estimateTokens(SUMMARY_BLOCK_HEADER);

/** 拼进 system prompt 时多出来的换行等开销 */
const SUMMARY_JOIN_OVERHEAD_TOKENS = 8;

/**
 * 把摘要正文渲染成 system prompt 的一段，并按预算截断。
 *
 * 预算算的是**整段**（固定说明 + 正文），跟记忆段的算法一致。
 *
 * ## 为什么不能「分段算完就拼」
 * estimateTokens 是**分段 ceil** 的，`estimate(头) + estimate(正文)` 不等于
 * `estimate(头 + 正文)`（中间的换行也算字符，两边各自 ceil 也会差一两个）。
 * 所以这里拼完要**量一次真实成本**，超了就调正文预算重来。
 * 不量的话就是「预算设 600、实际 601」—— 差一个 token 也超。
 */
export function buildSummaryBlockText(summary: string | null, budget: number): string {
  if (summary === null || summary.trim() === '') {
    return '';
  }
  const full = summary.trim();
  let bodyBudget = budget - SUMMARY_HEADER_COST - SUMMARY_JOIN_OVERHEAD_TOKENS;
  let block = '';

  // 最多调 4 次：第一次一般就够（溢出通常只有 1~2 token）
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const body = truncateToTokenBudget(full, bodyBudget);
    if (body === '') {
      return '';
    }
    block = renderSummaryBlock(body);
    const cost = estimateTokens(block);
    if (cost <= budget) {
      return block;
    }
    bodyBudget -= cost - budget;
    if (bodyBudget <= 0) {
      // 预算连固定说明都放不下 → 这一轮干脆不注入摘要
      return '';
    }
  }
  return block;
}

// ============================================================
// 纯逻辑：分块
// ============================================================

/**
 * 把待摘要的消息按 token 预算分块。
 *
 * 为什么要分块：一次摘要调用的输入要控制住。200 轮对话全塞进去 = 几万 token，
 * 一次调用就烧掉不少钱。分块之后**一次只消化最老的一块**，剩下的下一轮再消化。
 *
 * 单条消息超预算时截断它的正文（一条消息最长是租户配的 max_input_chars，
 * 默认 2000 字 ≈ 3000 token，正常不会超；超了说明租户把上限调得很离谱）。
 */
export function chunkRowsByBudget(
  rows: readonly Message[],
  maxTokens: number,
): Message[][] {
  const chunks: Message[][] = [];
  let current: Message[] = [];
  let used = 0;

  for (const row of rows) {
    const cost = estimateTokens(row.content ?? '') + 8;
    if (current.length > 0 && used + cost > maxTokens) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    if (current.length === 0 && cost > maxTokens) {
      // 单条就超预算 → 截断正文再放
      const clipped = { ...row, content: truncateToTokenBudget(row.content ?? '', maxTokens) } as Message;
      current.push(clipped);
      used = maxTokens;
      continue;
    }
    current.push(row);
    used += cost;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

/** DB 行 → 摘要模型看得懂的轮次 */
export function rowsToSummaryTurns(rows: readonly Message[]): SummaryTurn[] {
  return rows.map((r) => ({
    role: r.role === 'assistant' ? 'assistant' : 'user',
    content: r.content ?? '',
  }));
}

// ============================================================
// 服务
// ============================================================

export interface SessionSummaryState {
  /** 摘要正文（null = 还没摘要过） */
  summary: string | null;
  /** 摘要覆盖到哪里了 */
  boundary: SummaryBoundary | null;
}

/** 读会话的摘要状态 */
export async function loadSummaryState(
  sessionId: string,
  tenantId?: string,
): Promise<SessionSummaryState> {
  const row = await Session.findOne({
    where: { id: sessionId, ...(tenantId === undefined ? {} : { tenant_id: tenantId }) },
    attributes: ['summary', 'metadata'],
  });
  if (row === null) {
    return { summary: null, boundary: null };
  }
  return {
    summary: row.summary ?? null,
    boundary: readSummaryBoundary(row.metadata ?? null),
  };
}

/** 摘要更新的结果 */
export interface SummaryUpdateResult {
  status: 'updated' | 'skipped' | 'failed';
  /** 新的摘要正文（updated 时有值） */
  summary: string | null;
  /** 新的边界 */
  boundary: SummaryBoundary | null;
  /** 这次并入摘要的轮次数 */
  turns: number;
  /** 这次花掉的 token（输入 + 输出） */
  tokens: number;
  /** 为什么跳过 / 失败 */
  reason: string | null;
}

/**
 * 同一会话的摘要任务串行化。
 *
 * 为什么需要：摘要是 fire-and-forget 的，上一轮的摘要任务可能还在跑，
 * 这一轮又触发一次 → 两次都在摘要同一段内容，白花一次调用的钱。
 * 这里用一个进程内 Set 做「同一会话同时只跑一个」的闸门。
 *
 * 多实例部署时这个闸门不跨进程（跟限流、预算累计一样的取舍），
 * 但重复摘要只是多花一次钱，不会写坏数据 —— 写之前会重新读边界。
 */
const inFlightSessions = new Set<string>();

/** 摘要调用的输出上限下限 —— 推理型模型的思考 token 也算输出 token，给小了会被截断 */
const MIN_SUMMARY_OUTPUT_TOKENS = 1200;

export interface SummaryUpdateParams {
  tenantId: string;
  userId: string | null;
  sessionId: string;
  /** 这一轮被丢掉的消息（调用方保证已经排除了「已进摘要」的部分） */
  droppedRows: readonly Message[];
  /** 对话模型配置（摘要模型的回落 + 输出上限的参考） */
  fallbackLlm: ResolvedLlmSettings;
}

/**
 * 把这一轮被丢掉的轮次折成摘要，写回 sessions.summary + 边界。
 *
 * **全程不抛错**：失败只记日志 + 返回 failed。
 * 调用方是 fire-and-forget 的，抛出去会变成未处理的 rejection。
 */
export async function summarizeDroppedTurns(
  params: SummaryUpdateParams,
): Promise<SummaryUpdateResult> {
  const empty: SummaryUpdateResult = {
    status: 'skipped',
    summary: null,
    boundary: null,
    turns: 0,
    tokens: 0,
    reason: null,
  };

  if (!config.CHAT.SUMMARY_ENABLED) {
    return { ...empty, reason: '平台总开关关闭' };
  }
  if (params.droppedRows.length === 0) {
    return { ...empty, reason: '这一轮没有需要压缩的轮次' };
  }

  // 租户级开关（租户也可以关掉摘要 —— 多一次 LLM 调用是成本）
  const tenantEnabled = await getSettingValue(params.tenantId, 'summary_enabled');
  if (tenantEnabled === false) {
    return { ...empty, reason: '租户关闭了会话摘要' };
  }

  // 同一会话不并发跑两个摘要任务
  if (inFlightSessions.has(params.sessionId)) {
    return { ...empty, reason: '上一个摘要任务还在跑' };
  }
  inFlightSessions.add(params.sessionId);

  try {
    return await runSummaryUpdate(params);
  } catch (err: unknown) {
    logger.error(
      {
        err: err instanceof Error ? err.message : String(err),
        tenantId: params.tenantId,
        sessionId: params.sessionId,
      },
      '会话摘要失败',
    );
    return { ...empty, status: 'failed', reason: '摘要过程出错' };
  } finally {
    inFlightSessions.delete(params.sessionId);
  }
}

/** 摘要的真正干活部分（已经过了所有闸门） */
async function runSummaryUpdate(params: SummaryUpdateParams): Promise<SummaryUpdateResult> {
  const { tenantId, userId, sessionId } = params;

  // 1) 重新读一遍当前状态 —— 上一轮的摘要任务可能刚写完
  const state = await loadSummaryState(sessionId, tenantId);

  // 2) 已经被摘要覆盖的部分不再重复摘要
  const fresh = splitHistoryByBoundary(params.droppedRows, state.boundary).fresh;
  if (fresh.length === 0) {
    return {
      status: 'skipped',
      summary: state.summary,
      boundary: state.boundary,
      turns: 0,
      tokens: 0,
      reason: '待摘要的内容已经在摘要里了',
    };
  }

  // 3) 分块 —— 一次只消化最老的一块，剩下的下一轮继续
  const chunks = chunkRowsByBudget(fresh, config.CHAT.SUMMARY_MAX_INPUT_TOKENS);
  const chunk = chunks[0];
  if (chunk === undefined || chunk.length === 0) {
    return {
      status: 'skipped',
      summary: state.summary,
      boundary: state.boundary,
      turns: 0,
      tokens: 0,
      reason: '没有可摘要的内容',
    };
  }

  // 4) 解析摘要模型：租户配的「会话摘要」模型 → 对话模型 → 平台默认
  let summaryLlm = params.fallbackLlm;
  let modelSource = 'chat-model';
  try {
    const resolved = await resolveSummaryLlm(tenantId);
    if (resolved.degraded !== null) {
      logger.warn({ tenantId, reason: resolved.degraded }, '会话摘要模型配置有问题，已降级');
    }
    summaryLlm = {
      ...params.fallbackLlm,
      apiKey: resolved.apiKey,
      baseUrl: resolved.baseUrl,
      model: resolved.model,
      provider: resolved.provider,
    };
    modelSource = resolved.source;
  } catch (err: unknown) {
    logger.warn(
      { tenantId, err: err instanceof Error ? err.message : String(err) },
      '解析会话摘要模型失败，本轮用对话模型摘要',
    );
  }

  // 5) 观测：独立一条 trace（跟记忆抽取同一个理由 ——
  //    摘要是额外的 LLM 调用，耗时几秒，挂在对话 trace 上会污染 p95 延迟指标）
  const trace = startTrace({
    tenantId,
    userId,
    sessionId,
    name: 'session.summarize',
    kind: 'summary',
    channel: null,
    metadata: { turns: chunk.length, model_source: modelSource },
  });

  try {
    const anthropic = createAnthropic({ apiKey: summaryLlm.apiKey, baseURL: summaryLlm.baseUrl });
    const llmSpan = trace.span('llm.summarize', 'llm', {
      model: summaryLlm.model,
      provider: summaryLlm.provider,
      model_source: modelSource,
      turns: chunk.length,
    });

    // ⚠️ maxRetries: 0 —— 重试策略统一由 withRetry 负责（它带抖动，
    //    SDK 自带的那层没有抖动，上游挂时会惊群，见 src/lib/retry.ts）
    const result = await withRetry(
      () =>
        generateText({
          model: anthropic(summaryLlm.model),
          system: buildSummarySystemPrompt(config.CHAT.SUMMARY_TARGET_CHARS),
          messages: [
            {
              role: 'user',
              content: renderSummaryInput({
                existingSummary: state.summary,
                turns: rowsToSummaryTurns(chunk),
              }),
            },
          ],
          temperature: 0,
          maxOutputTokens: Math.max(MIN_SUMMARY_OUTPUT_TOKENS, params.fallbackLlm.maxOutputTokens ?? 0),
          abortSignal: AbortSignal.timeout(config.CHAT.SUMMARY_TIMEOUT_MS),
          maxRetries: 0,
        }),
      {
        onRetry: (attempt: number, delayMs: number, err: unknown) => {
          logger.warn(
            { attempt, delayMs, err: err instanceof Error ? err.message : String(err) },
            'LLM 调用失败，准备重试',
          );
        },
      },
    );
    llmSpan.end({
      input_tokens: result.usage.inputTokens ?? 0,
      output_tokens: result.usage.outputTokens ?? 0,
    });

    const usage = {
      input_tokens: result.usage.inputTokens ?? 0,
      output_tokens: result.usage.outputTokens ?? 0,
    };

    // 6) 记账（摘要也是一次 LLM 调用，成本要进 cost_logs）
    const costSpan = trace.span('cost.record', 'cost');
    try {
      await recordLlmUsage({
        tenantId,
        userId,
        sessionId,
        messageId: null,
        provider: summaryLlm.provider,
        model: summaryLlm.model,
        usage: {
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
        },
      });
      costSpan.end({ tokens: usage.input_tokens + usage.output_tokens });
    } catch (err: unknown) {
      costSpan.fail(err);
    }

    // 7) 清洗 + 安全检查
    const raw = result.text.trim();
    const cleaned = sanitizeSummaryText(maskPiiText(raw));
    if (cleaned === '') {
      await trace.end({ status: 'error', metadata: { reason: '模型没给出摘要内容' } });
      return {
        status: 'failed',
        summary: state.summary,
        boundary: state.boundary,
        turns: chunk.length,
        tokens: usage.input_tokens + usage.output_tokens,
        reason: '模型没给出摘要内容',
      };
    }

    // 注入检查：摘要是要进 system prompt 的，命中 high 档就不写。
    // 不写的话边界不推进 → 下一轮会重新摘要同一段 → 无限重试。
    // 所以这里**推进边界但不写摘要**：那一段内容就此丢弃（跟截断一样），
    // 至少不会让注入内容进提示词，也不会陷入重试循环。
    const scan = scanInjectionRules(cleaned);
    if (scan.maxSeverity === 'high') {
      logger.warn(
        { tenantId, sessionId, severity: scan.maxSeverity },
        '会话摘要命中注入规则，已丢弃该段内容（边界照常推进）',
      );
      await writeSummaryState(sessionId, tenantId, state.summary, boundaryOf(chunk));
      await trace.end({
        status: 'error',
        metadata: { reason: '摘要命中注入规则，已丢弃' },
        usage: {
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          total_tokens: usage.input_tokens + usage.output_tokens,
        },
      });
      return {
        status: 'failed',
        summary: state.summary,
        boundary: boundaryOf(chunk),
        turns: chunk.length,
        tokens: usage.input_tokens + usage.output_tokens,
        reason: '摘要命中注入规则，已丢弃该段内容',
      };
    }

    // 8) 写库：摘要正文 + 边界
    const boundary = boundaryOf(chunk);
    await writeSummaryState(sessionId, tenantId, cleaned, boundary);

    await trace.end({
      status: 'success',
      provider: summaryLlm.provider,
      model: summaryLlm.model,
      usage: {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        total_tokens: usage.input_tokens + usage.output_tokens,
      },
      metadata: { turns: chunk.length, chars: cleaned.length },
    });

    logger.info(
      {
        tenantId,
        sessionId,
        turns: chunk.length,
        chars: cleaned.length,
        model: summaryLlm.model,
        modelSource,
      },
      '会话摘要已更新',
    );

    return {
      status: 'updated',
      summary: cleaned,
      boundary,
      turns: chunk.length,
      tokens: usage.input_tokens + usage.output_tokens,
      reason: null,
    };
  } catch (err: unknown) {
    logger.error(
      {
        err: err instanceof Error ? err.message : String(err),
        tenantId,
        sessionId,
      },
      '会话摘要调用失败',
    );
    await trace.fail(err);
    return {
      status: 'failed',
      summary: null,
      boundary: null,
      turns: 0,
      tokens: 0,
      reason: '摘要调用失败',
    };
  }
}

/** 一批消息的边界 = 最后一条消息的身份 */
function boundaryOf(rows: readonly Message[]): SummaryBoundary {
  const last = rows[rows.length - 1];
  if (last === undefined) {
    throw new Error('boundaryOf 需要至少一条消息');
  }
  // created_at 是「消息在历史里的位置」，缺了就没法切分历史。
  // 生产路径拿到的都是 DB 行（loadHistoryRows 查出来的），一定有值；
  // 这里显式报错而不是默默写个假时间 —— 假时间会让边界切错位置。
  if (!(last.created_at instanceof Date)) {
    throw new Error(`消息 ${last.id} 缺少 created_at，无法计算摘要边界`);
  }
  return {
    message_id: last.id,
    created_at: last.created_at.toISOString(),
  };
}

/** 写摘要正文 + 边界（带租户过滤 —— 会话 id 不该跨租户生效） */
async function writeSummaryState(
  sessionId: string,
  tenantId: string,
  summary: string | null,
  boundary: SummaryBoundary,
): Promise<void> {
  const row = await Session.findOne({
    where: { id: sessionId, tenant_id: tenantId },
    attributes: ['id', 'metadata'],
  });
  if (row === null) {
    throw new Error(`会话不存在：${sessionId}`);
  }
  row.summary = summary;
  row.metadata = writeSummaryBoundary(row.metadata ?? null, boundary);
  await row.save();
}
