import Router from '@koa/router';
import { getSequelize } from '../db';

/**
 * GET /health —— liveness probe，仅判断进程存活
 * 详见 docs/15-开发进度计划.md Step 1
 */
export const healthRouter = new Router();

healthRouter.get('/health', async (ctx) => {
  // 第一阶段：DB 没有暴露详细状态时退化为名字，已连接则返回名字。
  let dbState: string = 'unknown';
  try {
    dbState = getSequelize().getDatabaseName();
  } catch {
    dbState = 'not_initialized';
  }

  ctx.body = { ok: true, db: dbState, uptime: Math.floor(process.uptime()) };
});
