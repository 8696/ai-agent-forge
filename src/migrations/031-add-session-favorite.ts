import { DataTypes, QueryTypes, type QueryInterface } from 'sequelize';
import type { MigrationFn } from 'umzug';

/**
 * sessions 加一列 `favorite` —— 会话收藏（12-e 需求裁定表 #7）
 *
 * ## 为什么加
 *
 * 12-b §B1 的「已知限制」里有一条「联网开关、收藏：本期不做」——
 * 联网已按「跨系统」定为不做（12-e 裁定表 #6），**收藏是纯内部的**，所以做。
 *
 * 语义：会话列表里给用户一个「收藏」标记（星标），
 * 配合「只看收藏」的筛选，让用户能把重要的会话从一堆里挑出来。
 *
 * ## 索引
 *
 * idx_sessions_favorite (tenant_id, user_id, favorite) ——
 * 「只看收藏」这个查询是租户 + 用户 + 标记的组合，过滤条件没索引会全表扫。
 *
 * 幂等：列已存在就跳过。
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  const sequelize = queryInterface.sequelize;

  const [rows] = await sequelize.query<{ COLUMN_NAME: string }>(
    'SELECT COLUMN_NAME FROM information_schema.COLUMNS ' +
      'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    { replacements: ['sessions', 'favorite'], type: QueryTypes.SELECT },
  );
  if (Array.isArray(rows) && rows.length > 0) {
    return;
  }

  await sequelize.query(
    'ALTER TABLE sessions ADD COLUMN favorite BOOLEAN NOT NULL DEFAULT FALSE ' +
      "COMMENT '是否收藏（用户标记的重要会话）'",
  );
  await sequelize.query(
    'CREATE INDEX idx_sessions_favorite ON sessions (tenant_id, user_id, favorite)',
  );
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.query('DROP INDEX idx_sessions_favorite ON sessions');
  await queryInterface.sequelize.query('ALTER TABLE sessions DROP COLUMN favorite');
};
