/**
 * tests/unit/errors.test.ts
 * 对应 src/lib/errors.ts
 * 详见 docs/12-d-需求-运维稳定.md §D6
 */
import { describe, it, expect } from 'vitest';
import { AppError, ValidationError, AuthError, NotFoundError } from '../../src/lib/errors';

describe('errors · AppError 家族', () => {
  it('AppError 基础字段', () => {
    const e = new AppError('boom', 'BOOM', 500, { foo: 'bar' });
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(AppError);
    expect(e.message).toBe('boom');
    expect(e.code).toBe('BOOM');
    expect(e.statusCode).toBe(500);
    expect(e.details).toEqual({ foo: 'bar' });
    expect(e.name).toBe('AppError');
  });

  it('ValidationError 默认 statusCode=400', () => {
    const e = new ValidationError('字段错');
    expect(e.statusCode).toBe(400);
    expect(e.code).toBe('VALIDATION_ERROR');
  });

  it('ValidationError 可传 details', () => {
    const e = new ValidationError('字段错', { field: 'email' });
    expect(e.details).toEqual({ field: 'email' });
  });

  it('AuthError 默认 401 + 默认 message', () => {
    const e = new AuthError();
    expect(e.statusCode).toBe(401);
    expect(e.code).toBe('AUTH_ERROR');
    expect(e.message).toBe('Unauthorized');
  });

  it('AuthError 自定义 message', () => {
    const e = new AuthError('邮箱或密码错误');
    expect(e.message).toBe('邮箱或密码错误');
  });

  it('NotFoundError 自动拼「{resource} not found」', () => {
    const e = new NotFoundError('租户');
    expect(e.statusCode).toBe(404);
    expect(e.code).toBe('NOT_FOUND');
    expect(e.message).toBe('租户 not found');
  });

  it('所有子类都是 AppError + Error', () => {
    expect(new ValidationError('x')).toBeInstanceOf(AppError);
    expect(new AuthError()).toBeInstanceOf(AppError);
    expect(new NotFoundError('x')).toBeInstanceOf(AppError);
    expect(new ValidationError('x')).toBeInstanceOf(Error);
  });

  it('error-handler 应该识别（instanceof AppError → 对应 statusCode）', async () => {
    // 行为契约：error-handler.ts 用 instanceof AppError 取 statusCode
    const e: AppError = new ValidationError('x');
    expect(e.statusCode).toBe(400);
    // 这个断言保证 error-handler 的 if (err instanceof AppError) 分支能取到正确状态码
  });
});
