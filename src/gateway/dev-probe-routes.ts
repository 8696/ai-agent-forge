import Router from '@koa/router';
import { z } from 'zod';
import { config, resolveLlm } from '../config';
import { verifyToken, type JwtPayload } from '../lib/jwt';

/**
 * Dev-only 探活路由：生产环境（NODE_ENV=production）整个 router 都不挂，避免泄露内部端点。
 *
 * 端点：
 *   - `GET  /jwt-info`      —— 解码并验证一个 JWT（给开发/QA 验证三套登录发的 token）
 *   - `POST /probe/llm`     —— 用进程级 LLM 配置探活一次（前端 /dev/probe 页用）
 *
 * ⚠️ **都不需要登录** —— 这是给开发者用的本地工具，路由前缀是 `/api/_dev`，
 *    生产环境整个 router 不挂（见 src/server.ts）。
 *    真要收敛暴露面，前端的 `/dev/probe` 路由也只在 Vite dev 模式下注册（见 web/routes.tsx）。
 */
export const devProbeRouter = new Router({ prefix: '/api/_dev' });

interface JwtInfoResult {
  ok: boolean;
  payload?: {
    sub: string;
    role: 'system' | 'admin' | 'customer';
    tenant_id?: string;
    iat?: number;
    exp?: number;
  };
  error?: string;
}

/**
 * GET /api/_dev/jwt-info
 *
 * 测试用：把 Authorization: Bearer <token> 里的 JWT 解码 + 验证并返回 payload。
 * 不写库、不发审计，纯粹给开发/QA 验证 3 套登录发出来的 JWT 是否可被中间件正确解析。
 * 生产环境直接 404。
 */
devProbeRouter.get('/jwt-info', async (ctx) => {
  if (config.NODE_ENV === 'production') {
    ctx.status = 404;
    return;
  }

  const header = ctx.request.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (match === null || match[1] === undefined || match[1].length === 0) {
    ctx.status = 400;
    ctx.body = { ok: false, error: '缺少 Authorization: Bearer <token>' } satisfies JwtInfoResult;
    return;
  }
  const token = match[1];

  try {
    const decoded = verifyToken(token) as JwtPayload & {
      iat?: number;
      exp?: number;
    };
    ctx.body = {
      ok: true,
      payload: {
        sub: decoded.sub,
        role: decoded.role,
        ...(decoded.role !== 'system' ? { tenant_id: decoded.tenant_id } : {}),
        ...(decoded.iat !== undefined ? { iat: decoded.iat } : {}),
        ...(decoded.exp !== undefined ? { exp: decoded.exp } : {}),
      },
    } satisfies JwtInfoResult;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.body = { ok: false, error: message } satisfies JwtInfoResult;
  }
});

// ============================================================
// LLM 探活
// ============================================================

const probeBodySchema = z.object({
  provider: z.enum(['minimax', 'zhipu', 'deepseek', 'qwen', 'custom']).optional(),
});

/**
 * POST /api/_dev/probe/llm
 *
 * 用**进程级** LLM 配置探活一次（`.env` 的 provider 凭据），不发消息、不落库。
 * ⚠️ 会真的调一次模型 —— 花钱，但只花几厘钱（16 token）。
 *
 * ⚠️ 生产环境直接 404（整个 router 在生产不挂，这里再挡一层双保险）。
 */
devProbeRouter.post('/probe/llm', async (ctx) => {
  if (config.NODE_ENV === 'production') {
    ctx.status = 404;
    return;
  }
  const parsed = probeBodySchema.safeParse(ctx.request.body ?? {});
  const provider = parsed.success ? parsed.data.provider : undefined;

  const { createAnthropic } = await import('@ai-sdk/anthropic');
  const { generateText } = await import('ai');

  let cfg;
  try {
    cfg = resolveLlm(provider);
  } catch (err: unknown) {
    ctx.status = 200;
    ctx.body = {
      ok: false,
      provider: provider ?? config.LLM_PROVIDER,
      error: err instanceof Error ? err.message : String(err),
    };
    return;
  }

  const startedAt = Date.now();
  try {
    const anthropic = createAnthropic({ apiKey: cfg.llmApiKey, baseURL: cfg.llmBaseUrl });
    const res = await generateText({
      model: anthropic(cfg.llmModel),
      prompt: '回复两个字：正常',
      maxOutputTokens: 16,
      temperature: 0,
    });
    ctx.body = {
      ok: true,
      provider: cfg.provider,
      model: cfg.llmModel,
      baseUrl: cfg.llmBaseUrl,
      text: res.text,
      usage: res.usage,
      durationMs: Date.now() - startedAt,
    };
  } catch (err: unknown) {
    // 探活失败也返 200 —— 失败本身就是有效信息（要让页面显示出来）
    ctx.status = 200;
    ctx.body = {
      ok: false,
      provider: cfg.provider,
      error: err instanceof Error ? err.message : String(err),
    };
  }
});
