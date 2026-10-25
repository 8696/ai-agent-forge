import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * 当前请求的租户上下文 —— 租户隔离的**运行时锚点**（docs/12-a-需求-多租户与登录.md §A1）
 *
 * ## 为什么需要它
 *
 * A1 的原始规格是「模型层 scope + beforeFind hook（自动加 tenant_id 过滤）」。
 * 光有 hook 不够 —— hook 得知道「当前是哪个租户」，而租户来自 JWT，
 * 只有请求上下文里才有。
 *
 * 三种做法：
 *   1. 每次查询手写 `where: { tenant_id }` —— 靠人记得，漏一次就是跨租户泄露
 *   2. 每次查询手写 `Model.scope('byTenant', { tenantId })` —— 还是靠人记得
 *   3. **请求级上下文 + 全局 hook** —— 人不用记得，hook 自动补
 *
 * 选 3。AsyncLocalStorage 是 Node 内置的（`node:async_hooks`），不引新依赖。
 * 它跟着 async 调用链走，所以请求中途 fire-and-forget 出去的后台任务
 * （记忆抽取 / 会话摘要 / 评测跑批）**仍然带着正确的租户上下文**。
 *
 * ## 没有上下文的场合 = 平台级视角
 *
 * `system` 子系统（平台方）刻意**不设置**上下文 —— 它本来就要跨租户看数据
 * （租户列表、跨租户 KPI）。这种查询不会被自动加过滤，是设计如此。
 */
interface TenantScope {
  tenantId: string;
}

const storage = new AsyncLocalStorage<TenantScope>();

/**
 * 在指定租户的上下文里跑一段逻辑。
 *
 * 用法（Koa 中间件）：
 * ```ts
 * export function requireAdmin(ctx: Context, next: Next): Promise<void> {
 *   const u = ctx.state.user as TenantUserJwtPayload;
 *   ctx.state.adminUser = u;
 *   return runWithTenant(u.tenant_id, next);
 * }
 * ```
 */
export function runWithTenant<T>(tenantId: string, fn: () => T): T {
  return storage.run({ tenantId }, fn);
}

/**
 * 当前上下文里的租户 id；没有上下文（比如平台方视角、启动期任务）返回 undefined。
 *
 * ⚠️ 返回 undefined **不等于**「没有租户隔离」——
 * 那说明这次查询本来就不该被租户过滤（平台级查询 / 启动期重建索引）。
 */
export function currentTenantId(): string | undefined {
  return storage.getStore()?.tenantId;
}

/** 测试用：清掉当前上下文（避免测试之间串味） */
export function clearTenantContext(): void {
  storage.disable();
}
