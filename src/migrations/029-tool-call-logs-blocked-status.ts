import { QueryTypes, type QueryInterface } from 'sequelize';
import type { MigrationFn } from 'umzug';

/**
 * tool_call_logs.status 加一档 'blocked'（前置步骤没满足，被工作流闸门拦下）
 *
 * 2026-10-26 给 B5 工作流闸门加了一条新的拦截路径：
 * **前置步骤没满足** —— 模型想直接提交退款，但还没查过订单，
 * 闸门拦住并回灌一句「请先调用 query_order_status」。
 *
 * 这条路径既不是 `awaiting_confirmation`（没人要点头），
 * 也不是 `rejected`（用户没拒绝），也不是 `error`（不是失败）——
 * 它是**流程约束**。混用现有任何一个值都会让后台的筛选失真：
 * 「待确认」里会混进一堆根本没让用户点过头的记录，
 * 「失败」会把错误率算高（本来就不是错）。
 *
 * 幂等：列已经有 'blocked' 就跳过。
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  const rows = await queryInterface.sequelize.query<{ COLUMN_TYPE: string }>(
    'SELECT COLUMN_TYPE FROM information_schema.COLUMNS ' +
      'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    { replacements: ['tool_call_logs', 'status'], type: QueryTypes.SELECT },
  );
  const current = rows[0]?.COLUMN_TYPE ?? '';
  if (current.includes('blocked')) {
    return;
  }
  await queryInterface.sequelize.query(
    'ALTER TABLE tool_call_logs MODIFY COLUMN status ' +
      "ENUM('ok','error','timeout','awaiting_confirmation','rejected','blocked') " +
      "NOT NULL DEFAULT 'ok' COMMENT 'ok=成功 / error=抛错 / timeout=超时 / awaiting_confirmation=待用户确认（未执行） / rejected=用户拒绝 / blocked=前置步骤未满足（流程约束）'",
  );
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  // 先把 blocked 的行挪走（ENUM 收窄会把不存在的值截断成空串）
  await queryInterface.sequelize.query(
    "UPDATE tool_call_logs SET status = 'error' WHERE status = 'blocked'",
  );
  await queryInterface.sequelize.query(
    'ALTER TABLE tool_call_logs MODIFY COLUMN status ' +
      "ENUM('ok','error','timeout','awaiting_confirmation','rejected') " +
      "NOT NULL DEFAULT 'ok' " +
      "COMMENT 'ok=成功 / error=抛错 / timeout=超时 / awaiting_confirmation=待用户确认（未执行） / rejected=用户拒绝'",
  );
};
