import Router from '@koa/router';
import { z } from 'zod';
import { apiKeyAuth, type ApiContext } from './api-key-auth';
import { runStreamLoop } from '../agent-orchestrator/loop-stream';
import { buildLlm } from '../lib/llm';
import { logger } from '../logger';

/**
 * 对外 Chat 路由（同步版）—— 详见 docs/06 §6.2 + docs/15 §Step 6/7
 *
 * 路由前缀：/api/v1
 * 鉴权：apiKeyAuth（Bearer ak_xxx / X-API-Key）
 *
 * 端点：
 *   POST /chat    同步：一次返回完整文本
 *
 * Step 7 新增：
 *   - body 可选 `session_id`：提供则从该 session 拉历史 + 持久化新消息
 *   - 不提供则按 Step 6 行为（无持久化的 stateless 同步）
 *
 * 响应：
 *   { reply, model, provider, usage, session_id }
 *
 * 同步版给「非浏览器调用方」（脚本 / 后台 worker / 单元测试）用。
 * 浏览器端挂件走 POST /chat/stream（chat-stream-routes.ts）拿 SSE 流式。
 *
 * 实现说明：复用 runStreamLoop（streamText 等价于 generateText + collect text）；
 *   for 同步场景我们等 result.text + usage，再 await afterStream 落库。
 */

export const chatRouter = new Router({ prefix: '/api/v1' });

chatRouter.use(apiKeyAuth);

const ChatBody = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant', 'system']),
        content: z.string().min(0).max(64_000),
      }),
    )
    .min(1)
    .max(100),
  /** Step 7：可选 session id */
  session_id: z.string().optional(),
  max_tokens: z.number().int().min(1).max(8192).optional(),
  temperature: z.number().min(0).max(2).optional(),
});

chatRouter.post('/chat', async (ctx) => {
  const api = ctx.state.apiContext as ApiContext;
  const input = ChatBody.parse(ctx.request.body);

  const t0 = Date.now();
  const { result, afterStream, sessionId } = await runStreamLoop({
    tenantId: api.tenantId,
    ...(input.session_id !== undefined ? { sessionId: input.session_id } : {}),
    newMessages: input.messages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
    ...(input.max_tokens !== undefined ? { maxTokens: input.max_tokens } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
  });

  let reply: string;
  let usage: unknown;
  try {
    reply = await result.text;
    usage = await result.usage;
  } catch (err: unknown) {
    logger.error(
      {
        tenantId: api.tenantId,
        err: err instanceof Error ? err.message : String(err),
      },
      'POST /chat · LLM 调用失败',
    );
    throw err;
  }

  // 同步场景下必须等 afterStream 让 messages 写完再返回（保证调用方下次读历史能看见）
  await afterStream;

  logger.info(
    {
      tenantId: api.tenantId,
      apiKeyId: api.apiKeyId,
      sessionId,
      msgCount: input.messages.length,
      replyChars: reply.length,
      durationMs: Date.now() - t0,
    },
    'POST /chat完成',
  );

  ctx.body = {
    reply,
    model: buildLlm().modelId,
    provider: buildLlm().provider,
    usage,
    session_id: sessionId,
  };
});
