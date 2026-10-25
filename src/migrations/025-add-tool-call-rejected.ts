import { QueryTypes, type QueryInterface } from 'sequelize';
import type { MigrationFn } from 'umzug';

/**
 * tool_call_logs.status 加一档 'rejected'（用户点了「取消」）
 *
 * 2026-10-25 给 HITL 补了「取消」路径：用户点完「确认执行」还能反悔。
 * 拒绝这件事也要在流水里看得见 —— 否则后台只看到「待确认」，
 * 不知道用户最后是点了确认还是点了取消。
 *
 * 幂等：列已经是目标枚举就跳过。
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  const rows = await queryInterface.sequelize.query<{ COLUMN_TYPE: string }>(
    'SELECT COLUMN_TYPE FROM information_schema.COLUMNS ' +
      'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    { replacements: ['tool_call_logs', 'status'], type: QueryTypes.SELECT },
  );
  const current = rows[0]?.COLUMN_TYPE ?? '';
  if (current.includes('rejected')) {
    return;
  }
  await queryInterface.sequelize.query(
    "ALTER TABLE tool_call_logs MODIFY COLUMN status " +
      "ENUM('ok','error','timeout','awaiting_confirmation','rejected') " +
      "NOT NULL DEFAULT 'ok' COMMENT 'ok=成功 / error=抛错 / timeout=超时 / awaiting_confirmation=待用户确认（未执行） / rejected=用户拒绝'",
  );
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  // 先把 rejected 的行挪走（ENUM 收窄会把不存在的值截断成空串）
  await queryInterface.sequelize.query(
    "UPDATE tool_call_logs SET status = 'awaiting_confirmation' WHERE status = 'rejected'",
  );
  await queryInterface.sequelize.query(
    "ALTER TABLE tool_call_logs MODIFY COLUMN status " +
      "ENUM('ok','error','timeout','awaiting_confirmation') NOT NULL DEFAULT 'ok' " +
      "COMMENT 'ok=成功 / error=抛错 / timeout=超时 / awaiting_confirmation=待用户确认（未执行）'",
  );
};
