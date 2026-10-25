import type { Context, Next } from 'koa';
import { ZodError } from 'zod';
import { AppError } from '@/lib/errors';
import { logger } from '../logger';

/**
 * Koa 统一错误处理中间件 —— 详见 docs/03-a-技术栈-工程化规范.md §A.13
 * - 业务错误（AppError 子类）走对应状态码
 * - ZodError → 400 + 校验失败详情
 * - 未知错误走 500 + 控制台日志，**绝不** 把内部消息直接抛给客户端
 */
export async function errorHandler(ctx: Context, next: Next): Promise<void> {
  try {
    await next();
  } catch (err: unknown) {
    if (err instanceof AppError) {
      ctx.status = err.statusCode;
      ctx.body = {
        code: err.code,
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
      };
      return;
    }
    if (err instanceof ZodError) {
      ctx.status = 400;
      ctx.body = {
        code: 'VALIDATION_ERROR',
        message: '参数校验失败',
        details: err.flatten(),
      };
      return;
    }
    logger.error({ err }, '未捕获错误');
    ctx.status = 500;
    ctx.body = { code: 'INTERNAL_ERROR', message: '服务器内部错误' };
  }
}
