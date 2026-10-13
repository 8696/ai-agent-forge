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
