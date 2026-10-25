/**
 * 原生 SQL 的时间参数处理 —— 给 `sequelize.query` 的 `replacements` 用
 *
 * ## 为什么需要这一层
 *
 * 本项目的 DATETIME 列（`started_at` / `created_at` 等）**按 UTC 墙钟存** ——
 * Sequelize 的模型写入路径就是按 UTC 落的。
 *
 * 但 `sequelize.query(..., { replacements: [someDate] })` 会把 Date 渲染成
 * **本地**墙钟字符串。两边对不上 → 时间窗口算出来是错的。
 *
 * ### 典型症状（2026-10-26 凌晨发现）
 *
 * 服务器在 UTC+8。本地时间 2026-10-26 00:20（= UTC 2026-10-25 16:20）：
 *
 *   - 库里存的是 `'2026-10-25 16:20:21'`（UTC 墙钟）
 *   - 「今天」的窗口起点算成**本地**午夜 → 渲染成 `'2026-10-26 00:00:00'`
 *   - 比较：`'2026-10-25 16:20:21' >= '2026-10-26 00:00:00'` → **false**
 *   - 结果：「今日对话数」在**每天的前 8 小时都是 0**（UTC+8 时区）
 *
 * 测试 `tests/integration/admin-observability.test.ts` 正好在那个时间点跑，
 * 所以平时看不出来，一跨零点就炸。
 *
 * ## 用法
 *
 * ```ts
 * sequelize.query(`... WHERE created_at >= ? AND created_at < ?`, {
 *   replacements: [tenantId, utcWallClock(from), utcWallClock(to)],
 *   type: QueryTypes.SELECT,
 * });
 * ```
 *
 * ⚠️ **走模型查询的地方不用管这个** —— `Model.findAll({ where: { created_at: { [Op.gte]: d } } })`
 * 那条路径按 UTC 绑定参数，是对的。**只有原生 SQL 才要转。**
 */
export function utcWallClock(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}
