import { DataTypes, type DataType, type QueryInterface } from 'sequelize';
import type { MigrationFn } from 'umzug';
import { tableExists, listColumns } from './helpers/schema';

/**
 * 给 tenant_llm_configs 补两个对话参数列
 *
 * 背景（docs/12-c §C4）：租户后台只放「安全边界」和「平台成本边界」之外的参数。
 * 这两个正好在中间那档 —— 用户最常遇到的两个问题（答不准 / 忘事）的对应旋钮，
 * 且不碰安全边界（不受 SSRF 约束）也不放大平台成本（单轮内可控）：
 *   - retrieval_top_k    检索召回几个候选块
 *   - max_history_turns  AI 最多记多少轮历史
 *
 * 列可空（NULL = 用进程级 .env 的 CHAT_* 默认），这样租户只覆盖自己不一样的。
 *
 * 表名带 llm 但这两列是检索/记忆参数，严格说表该叫 tenant_chat_settings ——
 * 为了不折腾已有迁移，沿用本表，但在模型 JSDoc 和 05-a 里写清楚这张表的实际范围。
 */
const NEW_COLUMNS: Array<{
  name: string;
  definition: { type: DataType; allowNull: boolean; comment: string };
}> = [
  {
    name: 'retrieval_top_k',
    definition: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: '检索召回的候选块数；NULL = 用进程级 CHAT_RETRIEVAL_TOP_K',
    },
  },
  {
    name: 'max_history_turns',
    definition: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: '最多带多少轮历史进提示词；NULL = 用进程级 CHAT_MAX_HISTORY_TURNS',
    },
  },
];

export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  if (!(await tableExists(queryInterface, 'tenant_llm_configs'))) {
    // 表不存在 = 全新库，010 已经建全了
    return;
  }
  const existing = await listColumns(queryInterface, 'tenant_llm_configs');
  for (const column of NEW_COLUMNS) {
    if (existing.has(column.name)) {
      continue;
    }
    await queryInterface.addColumn('tenant_llm_configs', column.name, column.definition);
  }
  await queryInterface.sequelize.query(
    "ALTER TABLE tenant_llm_configs COMMENT = '租户级 LLM 与对话配置（覆盖 .env 进程级默认值）'",
  );
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  // 删列会丢租户的设置值，回滚走备份恢复（见 docs/13-扩展指南 §13.8）
  if (!(await tableExists(queryInterface, 'tenant_llm_configs'))) {
    return;
  }
  const existing = await listColumns(queryInterface, 'tenant_llm_configs');
  for (const column of NEW_COLUMNS) {
    if (existing.has(column.name)) {
      await queryInterface.removeColumn('tenant_llm_configs', column.name);
    }
  }
};