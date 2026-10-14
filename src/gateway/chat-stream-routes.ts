import Router from '@koa/router';
import { z } from 'zod';
import { Readable } from 'node:stream';
import { apiKeyAuth, type ApiContext } from './api-key-auth';
import { runStreamLoop } from '../agent-orchestrator/loop-stream';
import { logger } from '../logger';

/**
 * 对外 Chat 路由（流式版）—— 详见 docs/06 §6.2 + docs/15 §Step 6/7
 *
 * 路由前缀：/api/v1
 * 鉴权：apiKeyAuth（Bearer ak_xxx / X-API-Key）
 *
 * 端点：
 *   POST /chat/stream    SSE 流式：边生成边推送
 *
 * Step 7 新增：
 *   - body 可选 `session_id`：提供则从该 session 拉历史 + 持久化新消息
 *   - 不提供则按 Step 6 行为（无持久化的 stateless 流式）
 *
 * 响应格式（curl -N 看到）：
 *   data: 0:"你好"
 *   \n
 *   data: 0:"，有什么可以帮您？"
 *   \n
 *   data: e:{}
 *   \n
 *
 *   - 每条 data 行 = Vercel AI SDK data stream v1 协议的一个事件
 *     （0:"<text>" 文本片段 / e:{} 结束事件 / 8:<json> 错误事件）
 *   - 真正 SSE 解析（EventSource）会拿到每段文本片段
 *   - 浏览器端 useChat() 走同一协议，自带解析（无需 EventSource）
 */

export const chatStreamRouter = new Router({ prefix: '/api/v1' });

chatStreamRouter.use(apiKeyAuth);

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
  /** Step 7：可选 session id；提供则持久化 + 拉历史 */
  session_id: z.string().optional(),
  max_tokens: z.number().int().min(1).max(8192).optional(),
  temperature: z.number().min(0).max(2).optional(),
});

chatStreamRouter.post('/chat/stream', async (ctx) => {
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

  // 把 Vercel AI SDK data stream v1 包成 SSE：
  //   原协议：每条事件是一行，如 `0:"hello"` / `e:{}`，以 \n 结尾
  //   SSE 包：`data: <事件行>\n\n`
  const aiStream = result.toDataStream();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  const sseStream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.length > 0) {
          controller.enqueue(encoder.encode(`data: ${line}\n\n`));
        }
        nl = buffer.indexOf('\n');
      }
    },
    flush(controller) {
      const tail = buffer + decoder.decode();
      buffer = '';
      if (tail.length > 0) {
        controller.enqueue(encoder.encode(`data: ${tail}\n\n`));
      }
    },
  });
  const sseWeb = aiStream.pipeThrough(sseStream);

  logger.info(
    {
      tenantId: api.tenantId,
      apiKeyId: api.apiKeyId,
      sessionId,
      msgCount: input.messages.length,
      hasSession: input.session_id !== undefined,
    },
    'POST /chat/stream 已开始',
  );

  ctx.status = 200;
  ctx.set('Content-Type', 'text/event-stream; charset=utf-8');
  ctx.set('Cache-Control', 'no-cache, no-transform');
  ctx.set('Connection', 'keep-alive');
  ctx.set('X-Accel-Buffering', 'no');
  // 把 session_id 放在 header 让前端首次创建时回填
  if (input.session_id === undefined) {
    ctx.set('X-Session-Id', sessionId);
  }
  ctx.body = Readable.fromWeb(sseWeb);

  // 异步等待 stream 完成 + messages 持久化（不阻塞响应）
  // 让 Koa 响应走完后再继续写库
  void afterStream.then(() => {
    logger.info(
      {
        tenantId: api.tenantId,
        sessionId,
        durationMs: Date.now() - t0,
      },
      'POST /chat/stream 流式完成 + 落库',
    );
  }).catch((err: unknown) => {
    logger.error(
      {
        tenantId: api.tenantId,
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      },
      'POST /chat/stream 落库失败',
    );
  });
});
