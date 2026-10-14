import Router from '@koa/router';
import { z } from 'zod';
import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText } from 'ai';
import { config, resolveLlm, type LlmProvider } from '../config';
import { logger } from '../logger';

/**
 * Dev-only 探活路由：给前端一个按钮直接调，不用等用户去 terminal 跑 tsx。
 * 生产环境（NODE_ENV=production）整个 router 都不挂，避免泄露内部端点。
 */
export const devProbeRouter = new Router({ prefix: '/api/_dev' });

const ProbeBody = z.object({
  provider: z.enum(['minimax', 'zhipu', 'deepseek', 'qwen', 'custom']).optional(),
});

type ProbeResult =
  | {
      ok: true;
      provider: LlmProvider;
      model: string;
      baseUrl: string;
      text: string;
      usage: unknown;
      durationMs: number;
    }
  | { ok: false; provider: LlmProvider; error: string };

devProbeRouter.post('/probe/llm', async (ctx) => {
  if (config.NODE_ENV === 'production') {
    ctx.status = 404;
    return;
  }

  const parsed = ProbeBody.safeParse(ctx.request.body);
  if (!parsed.success) {
    ctx.status = 400;
    ctx.body = { ok: false, error: parsed.error.flatten().fieldErrors };
    return;
  }

  const provider: LlmProvider = parsed.data.provider ?? config.LLM_PROVIDER;

  try {
    const cfg = resolveLlm(provider);
    const client = createAnthropic({ apiKey: cfg.llmApiKey, baseURL: cfg.llmBaseUrl });
    const t0 = Date.now();
    const res = await generateText({
      model: client(cfg.llmModel),
      prompt: 'reply with the single word: pong',
      maxTokens: 32,
    });
    const body: ProbeResult = {
      ok: true,
      provider: cfg.provider,
      model: cfg.llmModel,
      baseUrl: cfg.llmBaseUrl,
      text: res.text,
      usage: res.usage,
      durationMs: Date.now() - t0,
    };
    ctx.body = body;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ provider, err: message }, 'dev probe LLM 失败');
    ctx.body = { ok: false, provider, error: message } satisfies ProbeResult;
    ctx.status = 502;
  }
});
