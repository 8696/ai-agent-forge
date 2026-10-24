/**
 * 自定义错误类 —— 详见 docs/03-技术栈与规范.md §A.13
 */
export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly details: unknown;

  constructor(message: string, code: string, statusCode = 500, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 'VALIDATION_ERROR', 400, details);
  }
}

export class AuthError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 'AUTH_ERROR', 401);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super(`${resource} not found`, 'NOT_FOUND', 404);
  }
}

/**
 * 触发限流 —— D5（docs/12-d-需求-运维稳定.md §D5）
 *
 * 429 + Retry-After 是标准语义：客户端照着 Retry-After 退避重试就行。
 */
export class RateLimitError extends AppError {
  constructor(message: string, retryAfterMs: number) {
    super(message, 'RATE_LIMITED', 429, { retry_after_ms: retryAfterMs });
  }
}

/**
 * 内容被安全策略拦下 —— D4（docs/12-d-需求-运维稳定.md §D4）
 *
 * 403 而不是 400：请求本身语法没问题，是**内容**不允许。
 * details.category 用来区分是「内容违规」还是「提示词注入」。
 */
export class ContentBlockedError extends AppError {
  constructor(message: string, category: string) {
    super(message, 'CONTENT_BLOCKED', 403, { category });
  }
}

/**
 * 超出成本预算 —— D3（docs/12-d-需求-运维稳定.md §D3）
 *
 * 只有服务端 .env 的 COST_BUDGET_BLOCK=true 时才会用得上；
 * 默认只告警不拦截（拦截是运营决策，不该由平台默认替租户做）。
 */
export class BudgetExceededError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 'COST_BUDGET_EXCEEDED', 403, details);
  }
}
