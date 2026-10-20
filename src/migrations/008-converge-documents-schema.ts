import { DataTypes, type DataType, type QueryInterface } from 'sequelize';
import type { MigrationFn } from 'umzug';
import { tableExists, listColumns } from './helpers/schema';

/**
 * 收敛 documents 表到当前 schema —— 详见 docs/05-a-数据模型-mysql.md §知识库文档表
 *
 * **为什么需要这条**：开发库上可能已经存在一张更早版本创建的 `documents` 表
 * （早期实现建过同名表，schema 少几个字段）。那种情况下 007 会被跳过
 * （已记进 sequelize_meta）或撞上「表已存在」而中断，字段永远补不上。
 *
 * 所以这条迁移不假设表是自己建的：**逐列比对，缺哪列补哪列**，两种情况都收敛：
 *  - 全新库：007 建全了表 → 这里什么都不做
 *  - 老库：007 被跳过 → 这里把缺的列补上
 *
 * 加字段是幂等的：information_schema 里已经存在就不再 ALTER。
 *
 * down 不删列 —— 删列会丢数据，且无法从旧版本迁移脚本可靠重建。
 * 真要回滚应该 `yarn migrate:undo` 之后从备份恢复。
 */

/** 当前 schema 要求存在、但老版本可能缺的列 */
const DESIRED_COLUMNS: Array<{
  name: string;
  definition: { type: DataType; allowNull: boolean; comment: string };
}> = [
  {
    name: 'error_message',
    definition: {
      type: DataTypes.STRING(1000),
      allowNull: true,
      comment: '最近一次索引失败的错误摘要（status=failed 时给前端展示）',
    },
  },
];

export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  if (!(await tableExists(queryInterface, 'documents'))) {
    // 表不存在 = 全新库，007 已经建全了，这里无事可做
    return;
  }

  const existing = await listColumns(queryInterface, 'documents');
  for (const column of DESIRED_COLUMNS) {
    if (existing.has(column.name)) {
      continue;
    }
    await queryInterface.addColumn('documents', column.name, column.definition);
  }
};

export const down: MigrationFn<QueryInterface> = async (): Promise<void> => {
  // 见文件头说明：删列会丢数据，回滚走备份恢复
};