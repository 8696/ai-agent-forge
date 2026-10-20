import { QueryTypes, type QueryInterface } from 'sequelize';

/**
 * 迁移期查 information_schema 的小工具。
 *
 * 用途：让迁移能在「表可能已经存在、也可能不存在」的前提下安全判断，
 * 而不是靠 try/catch 猜错误类型（迁移里吞异常会把真正的失败一起吞掉）。
 *
 * 只在迁移阶段使用；业务代码一律走 Sequelize Model，不要查 information_schema。
 */

interface CountRow {
  n: number;
}

/** 表在当前库里是否存在 */
export async function tableExists(
  queryInterface: QueryInterface,
  table: string,
): Promise<boolean> {
  const rows = await queryInterface.sequelize.query<CountRow>(
    'SELECT COUNT(*) AS n FROM information_schema.TABLES ' +
      'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    { replacements: [table], type: QueryTypes.SELECT },
  );
  return rows.length > 0 && Number(rows[0]?.n ?? 0) > 0;
}

/** 表已有哪些列 */
export async function listColumns(
  queryInterface: QueryInterface,
  table: string,
): Promise<Set<string>> {
  const rows = await queryInterface.sequelize.query<{ COLUMN_NAME: string }>(
    'SELECT COLUMN_NAME FROM information_schema.COLUMNS ' +
      'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    { replacements: [table], type: QueryTypes.SELECT },
  );
  return new Set(rows.map((r) => r.COLUMN_NAME));
}