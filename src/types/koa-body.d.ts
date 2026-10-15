// 类型 augment —— @koa/router@15 的 RouterContext 用 inline literal
// { params: Record<string, string> } 重写了 request 字段，导致 koa.Request
// 的合并 augmentation（包括 @types/koa-bodyparser 给的 body?: unknown）
// 在 router 推 ctx.request 时丢失。本文件强制给 koa.Request 加 body/rawBody。
import 'koa';

declare module 'koa' {
  interface Request {
    body?: unknown;
    rawBody?: string;
  }
}

export {};
