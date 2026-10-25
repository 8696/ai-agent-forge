import { QueryTypes, type QueryInterface } from 'sequelize';
import type { MigrationFn } from 'umzug';
import { logger } from '../logger';
import { tableExists } from './helpers/schema';

/**
 * 收窄 documents.file_type 的 ENUM —— 去掉 'word'（Word / DOCX 解析已从需求里删除）
 *
 * ## 起因
 *
 * 2026-10-25 决定把 **DOCX 解析整个从需求里删掉**（不再做）：
 *  - docs/01 §1.1 的上传格式从「PDF / Word / Markdown / TXT」改成「PDF / Markdown / TXT」
 *  - docs/12-c §C1 里「不支持 .docx」的说明整条删掉（不再声称支持 Word，就不用解释不支持）
 *  - docs/05-a 的 `file_type` DDL 去掉 'word'
 *
 * 代码侧同步收口：`DocumentFileType` 类型、Sequelize 的 ENUM 定义、
 * `extractText()` 的 `case 'word'` 分支、前端的类型联合，全都去掉了 'word'。
 *
 * ## 为什么还要改数据库
 *
 * 只改 TS 类型不够 —— 库里的列还是 `ENUM('pdf','word','markdown','txt')`，
 * 而 Sequelize 的 `sync` 不跑、迁移才是唯一改 schema 的途径。
 * 留着 'word' 就是一个「代码里不可能出现、库里却允许」的死枚举值。
 *
 * ## 幂等 / 安全
 *
 *  - 表不存在 → 跳过（全新库还没建表）
 *  - 列的 ENUM 里已经没有 'word' → 跳过（重复执行安全）
 *  - 万一有行的 file_type='word'：先置 NULL（file_type 可空）再 ALTER，
 *    避免 MySQL 严格模式下 ALTER 直接失败。正常情况下这个数是 0
 *    —— 上传白名单（src/services/document-upload.ts）从来只放行 pdf / md / txt
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  if (!(await tableExists(queryInterface, 'documents'))) {
    return;
  }

  const rows = await queryInterface.sequelize.query<{ COLUMN_TYPE: string }>(
    'SELECT COLUMN_TYPE FROM information_schema.COLUMNS ' +
      'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    { replacements: ['documents', 'file_type'], type: QueryTypes.SELECT },
  );
  const columnType = rows[0]?.COLUMN_TYPE ?? '';
  if (!columnType.toLowerCase().includes("'word'")) {
    return;
  }

  // 正常不会有这种行（上传白名单不放行 .docx）；有的话先清掉，别让 ALTER 炸
  const countRows = await queryInterface.sequelize.query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM documents WHERE file_type = 'word'",
    { type: QueryTypes.SELECT },
  );
  const wordRows = Number(countRows[0]?.n ?? 0);
  if (wordRows > 0) {
    logger.warn(
      { count: wordRows },
      'documents.file_type 存在 word 行（上传白名单不该产生这种行），置 NULL 后再收窄 ENUM',
    );
    await queryInterface.sequelize.query(
      "UPDATE documents SET file_type = NULL WHERE file_type = 'word'",
    );
  }

  await queryInterface.sequelize.query(
    "ALTER TABLE documents MODIFY COLUMN file_type ENUM('pdf','markdown','txt') " +
      "NULL COMMENT '文件类型'",
  );
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  if (!(await tableExists(queryInterface, 'documents'))) {
    return;
  }

  await queryInterface.sequelize.query(
    "ALTER TABLE documents MODIFY COLUMN file_type ENUM('pdf','word','markdown','txt') " +
      "NULL COMMENT '文件类型'",
  );
};
