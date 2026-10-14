import { streamText, type LanguageModelUsage, type StreamTextResult } from 'ai';
import { Session, Message, type MessageRole } from '../models';
import { loadSystemPrompt } from '../lib/load-prompt';
import { buildTools } from './tools';
import { buildLlm } from '../lib/llm';
import {
  DEFAULT_BUDGET,
  estimateMessagesTokens,
  truncateHistoryToBudget,
} from '../lib/token-budget';
import { summarizeEarlyHistory } from '../lib/summarize';
import { logger } from '../logger';

/**
 * 流式主对话循环 —— 详见 docs/16-b §B1 + docs/15 §Step 7 + docs/03-b §B.4 agent-orchestrator
 *
 * 流程：
 *  1. 加载 system 提示词（按 tenant）
 *  2. 如有 sessionId：从 messages 表拉历史（短期记忆）
 *  3. 把新 user 消息追加到 history
 *  4. 估算 token：超 budget.history → 摘要压缩最早一段
 *  5. 拼 Anthropic prompt caching：system 消息挂 cacheControl ephemeral
 *  6. streamText 流式生成；用法 usage / token 持久化
 *  7. 收尾：assistant 消息入库 status=complete；session.title 第一次 user 消息后回填
 *
 * 调用方式（路由层）：
 *   const handle = await runStreamLoop({...});
 *   ctx.body = handle.result.toDataStream();  // 给前端 SSE
 *   await handle.afterStream;                  // 保证消息入库
 */

export interface LoopStreamInput {
  tenantId: string;
  /** 若提供：从该 session 拉历史 + 持久化新消息 */
  sessionId?: string | undefined;
  /** 本轮新追加的 user 消息（通常 1 条；可含 system 注入） */
  newMessages: Array<{ role: MessageRole; content: string }>;
  /** 会话接入渠道（决定 sessions.channel 字段；widget / email / api） */
  channel?: 'widget' | 'email' | 'api';
  /** 触发用户 ID（customer 走 JWT 时填 jwt.sub；API Key 调用方传 null） */
  userId?: string | null;
  /** 可选：覆盖默认 maxTokens */
  maxTokens?: number;
  /** 可选：覆盖默认 temperature */
  temperature?: number;
}

export interface LoopStreamHandle {
  /** Vercel AI SDK streamText result（让路由层负责 SSE 包装） */
  result: StreamTextResult<never, never>;
  /** 异步落库的清理钩子：路由在 stream 完成后 await 一下保证 messages 写库 */
  afterStream: Promise<void>;
  /** 真实生效的 session id（loop 自动新建时会回传） */
  sessionId: string;
}

/**
 * 启动流式主循环（async）
 *  - 调用方拿到 result 后可直接 `toDataStream()` 推到 SSE
 *  - 调用方在响应结束后 await afterStream 让 messages 完整入库
 */
export async function runStreamLoop(input: LoopStreamInput): Promise<LoopStreamHandle> {
  // 1. 准备消息（异步：DB + LLM 摘要可能触发）
  const prep = await prepareMessages(input);

  // 2. 启动 streamText（同步）
  const { model } = buildLlm();
  // 把 messagesWithCache 喂给 streamText：本地类型是 Anthropic cacheControl 标记
  //   streamText 的入参接受 CoreMessage[] / Omit<Message,'id'>[]；cacheControl 走 providerOptions
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = streamText({
    model,
    system: prep.system,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messages: prep.messagesWithCache as any,
    tools: buildTools(),
    ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
  }) as unknown as StreamTextResult<never, never>;

  // 3. 收尾：等 stream 完成 → 持久化（用户消息 + assistant 回复 + usage）
  const afterStream = persistAfterStream(input, prep, result);

  return { result, afterStream, sessionId: prep.sessionId };
}

interface PreparedMessages {
  /** 给 LLM 的 system 字符串 */
  system: string;
  /** 给 LLM 的完整 messages（含 cacheControl providerOptions） */
  messagesWithCache: Array<{
    role: MessageRole;
    content: string;
    providerOptions?: { anthropic: { cacheControl: { type: 'ephemeral' } } };
  }>;
  /** 真实生效的 session id（自动新建时回传） */
  sessionId: string;
}

async function prepareMessages(input: LoopStreamInput): Promise<PreparedMessages> {
  const system = await loadSystemPrompt(input.tenantId);

  // 1. 拉历史
  let history: Array<{ role: MessageRole; content: string }> = [];
  if (input.sessionId !== undefined) {
    const { loadShortTermHistory } = await import('../memory/short-term');
    const loaded = await loadShortTermHistory({
      sessionId: input.sessionId,
      tenantId: input.tenantId,
      limit: 50,
    });
    history = loaded.messages.map((m) => ({ role: m.role, content: m.content }));
  }

  // 2. 把新 user 消息追加
  history.push(...input.newMessages);

  // 3. token 预算检查
  const tokens = estimateMessagesTokens(history);
  if (tokens > DEFAULT_BUDGET.history) {
    // 把最早的一段（保留最新 6 条）摘成 summary
    const KEEP_TAIL = 6;
    const early = history.slice(0, Math.max(0, history.length - KEEP_TAIL));
    const tail = history.slice(-KEEP_TAIL);
    if (early.length > 0) {
      const { summary } = await summarizeEarlyHistory({
        tenantId: input.tenantId,
        earlyMessages: early.map((m) => ({ role: m.role, content: m.content })),
      });
      if (summary !== '') {
        history = [
          { role: 'system', content: `前面对话摘要：${summary}` },
          ...tail,
        ];
        logger.info(
          {
            tenantId: input.tenantId,
            sessionId: input.sessionId,
            compressedFrom: tokens,
            compressedTo: estimateMessagesTokens(history),
          },
          '历史超 budget，已摘要压缩',
        );
      } else {
        history = truncateHistoryToBudget(history, DEFAULT_BUDGET.history);
      }
    }
  }

  // 4. 校验 / 创建 session
  let sessionId = input.sessionId;
  if (sessionId === undefined) {
    const created = await Session.create({
      tenant_id: input.tenantId,
      user_id: input.userId ?? null,
      channel: input.channel ?? 'widget',
      status: 'active',
    });
    sessionId = created.id;
  } else {
    const exists = await Session.findOne({
      where: { id: sessionId, tenant_id: input.tenantId },
    });
    if (exists === null) {
      throw new Error(`session ${sessionId} 不属于 tenant ${input.tenantId}`);
    }
  }

  // 5. 把 system 消息标记 cacheControl ephemeral（Anthropic Prompt Caching）
  //   Step 7 验收要求「同一条 system prompt 重复发，看到 cache_read_input_tokens 命中」
  //   做法：system 消息 + 第一个 user 消息 各挂一个 cache breakpoint
  const messagesWithCache = history.map((m, idx) => {
    if (m.role === 'system' && idx === 0) {
      return {
        role: m.role,
        content: m.content,
        providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' as const } } },
      };
    }
    return { role: m.role, content: m.content };
  });

  return {
    system,
    messagesWithCache,
    sessionId,
  };
}

function persistAfterStream(
  input: LoopStreamInput,
  prep: PreparedMessages,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: any,
): Promise<void> {
  return (async () => {
    try {
      const [text, usage] = await Promise.all([result.text, result.usage]);
      await persistTurn({
        tenantId: input.tenantId,
        sessionId: prep.sessionId,
        newMessages: input.newMessages,
        assistantText: text,
        usage,
        status: 'complete',
      });
    } catch (err: unknown) {
      logger.error(
        {
          tenantId: input.tenantId,
          sessionId: prep.sessionId,
          err: err instanceof Error ? err.message : String(err),
        },
        'streamText 失败，写入 messages.status=failed',
      );
      try {
        await persistTurn({
          tenantId: input.tenantId,
          sessionId: prep.sessionId,
          newMessages: input.newMessages,
          assistantText: '',
          usage: undefined,
          status: 'failed',
        });
      } catch (e2: unknown) {
        logger.error({ err: e2 }, 'failed 落库也失败，吞掉（不阻塞响应）');
      }
    }
  })();
}

interface PersistParams {
  tenantId: string;
  sessionId: string;
  newMessages: Array<{ role: MessageRole; content: string }>;
  assistantText: string;
  usage: LanguageModelUsage | undefined;
  status: 'complete' | 'failed';
}

/**
 * 持久化一轮：
 *  - 写 user 消息（每条新消息一条 messages 行）
 *  - 写 assistant 消息（如有内容 / 或 status=failed 也写一条占位）
 *  - usage 存 messages.usage JSON
 *  - 第一次 user 消息入库后回填 session.title（前 20 字）
 */
async function persistTurn(p: PersistParams): Promise<void> {
  // 1. 写新消息（每条单独入库）
  for (const m of p.newMessages) {
    await Message.create({
      session_id: p.sessionId,
      tenant_id: p.tenantId,
      role: m.role,
      content: m.content,
      status: 'complete',
    });
  }

  // 2. 写 assistant 消息
  if (p.assistantText !== '' || p.status === 'failed') {
    await Message.create({
      session_id: p.sessionId,
      tenant_id: p.tenantId,
      role: 'assistant',
      content: p.assistantText === '' ? null : p.assistantText,
      status: p.status,
      usage: p.usage !== undefined ? serializeUsage(p.usage) : null,
    });
  }

  // 3. 第一次 user 消息 → 回填 session.title
  const firstUser = p.newMessages.find((m) => m.role === 'user');
  if (firstUser !== undefined) {
    const existing = await Session.findByPk(p.sessionId);
    if (existing !== null && (existing.title === null || existing.title === '')) {
      existing.title = firstUser.content.slice(0, 20);
      await existing.save();
    }
  }
}

function serializeUsage(u: LanguageModelUsage): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
} {
  return {
    promptTokens: u.promptTokens,
    completionTokens: u.completionTokens,
    totalTokens: u.totalTokens,
  };
}
