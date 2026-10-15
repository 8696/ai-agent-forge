import Router from '@koa/router';
import { config } from '../config';
import { verifyToken, type JwtPayload } from '../lib/jwt';

/**
 * Dev-only 探活路由：生产环境（NODE_ENV=production）整个 router 都不挂，避免泄露内部端点。
 *
 * 当前仅保留 `/jwt-info`（给开发/QA 验证 3 套登录发出来的 JWT）。
 * 原 LLM probe 随 agent-orchestrator + lib/llm 删除一并移除。
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
