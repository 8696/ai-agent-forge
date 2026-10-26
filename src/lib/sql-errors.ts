/**
 * MySQL 错误识别 —— 「这一列不存在」是唯一需要特别认出来的那一种
 *
 * ## 为什么要单独拎出来
 *
 * 生产是「DBA 手动跑迁移 + 灰度」（docs/11），**代码可能先上线**。
 * Sequelize 的 SELECT 列清单来自**模型定义**，不是查询里写了什么 ——
 * 列不存在时，任何对那张表的查询都会报
 * `Unknown column 'xxx' in 'field list'`，而且是**整张表的所有路径**都挂
 * （不只是新加的那条查询）。
 *
 * 所以这类错误必须能被**认出来**，好让代码走降级分支：
 *  - `api_keys.key_sha256`（迁移 034）→ 摘掉这一列，退回前缀粗筛
 *  - `user_memories.embedding`（迁移 035）→ 摘掉这两列，退回固定顺序的记忆排序
 *
 * 认错的后果是反的：把「DB 抖了一下」当成「列不存在」→ 白白降级；
 * 把「列不存在」当成「DB 抖了」→ 每个请求撞一次 500。
 */

/**
 * MySQL 的「未知列」错误。
 *
 * mysql2 抛的是 `ER_BAD_FIELD_ERROR` / errno 1054 / SQLSTATE 42S22；
 * Sequelize 会把它包成 DatabaseError，原始错误挂在 `original`（有时也在 `parent`）。
 */
export function isMissingColumnError(err: unknown): boolean {
  const candidates: unknown[] = [err];
  if (err !== null && typeof err === 'object') {
    candidates.push((err as { original?: unknown }).original);
    candidates.push((err as { parent?: unknown }).parent);
  }
  for (const c of candidates) {
    if (c === null || typeof c !== 'object') {
      continue;
    }
    const e = c as { code?: string; errno?: number; sqlState?: string };
    if (e.code === 'ER_BAD_FIELD_ERROR' || e.errno === 1054 || e.sqlState === '42S22') {
      return true;
    }
  }
  return false;
}
