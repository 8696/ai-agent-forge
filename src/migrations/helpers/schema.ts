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

/** 当前库里有哪些表（不含视图） */
export async function listTables(queryInterface: QueryInterface): Promise<string[]> {
  const rows = await queryInterface.sequelize.query<{ TABLE_NAME: string }>(
    'SELECT TABLE_NAME FROM information_schema.TABLES ' +
      'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = ?',
    { replacements: ['BASE TABLE'], type: QueryTypes.SELECT },
  );
  return rows.map((r) => r.TABLE_NAME);
}

export interface TableCharset {
  /** 表的排序规则（如 utf8mb4_unicode_ci） */
  collation: string;
  /** 存储引擎（如 InnoDB） */
  engine: string;
}

/**
 * 每张表当前用的字符集 / 引擎。
 *
 * 用于「已经是目标状态就跳过」这类幂等判断 —— 避免每次跑迁移都重建一遍表。
 */
export async function listTableCharsets(
  queryInterface: QueryInterface,
): Promise<Map<string, TableCharset>> {
  const rows = await queryInterface.sequelize.query<{
    TABLE_NAME: string;
    TABLE_COLLATION: string | null;
    ENGINE: string | null;
  }>(
    'SELECT TABLE_NAME, TABLE_COLLATION, ENGINE FROM information_schema.TABLES ' +
      'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = ?',
    { replacements: ['BASE TABLE'], type: QueryTypes.SELECT },
  );
  const out = new Map<string, TableCharset>();
  for (const r of rows) {
    out.set(r.TABLE_NAME, {
      collation: r.TABLE_COLLATION ?? '',
      engine: r.ENGINE ?? '',
    });
  }
  return out;
}