import { QueryTypes, type QueryInterface } from 'sequelize';
import type { MigrationFn } from 'umzug';

/**
 * messages 加一列 `favorite` —— **消息级收藏**（docs/04-b-ui-登录与聊天挂件.md §4.2）
 *
 * ## 为什么加
 *
 * 规格 §4.2 的 AI 消息操作行列了 5 个按钮：👍 / 👎 / 复制 / 🔄 重新生成 / **📌 收藏**。
 * 以前只有会话级收藏（迁移 `031` 给 `sessions` 加的 `favorite`），
 * **消息级收藏没有落点** —— 前端画不出这个按钮，后端也没有地方存。
 *
 * 语义：用户把某一条 AI 回答标成「值得留着」，跟会话收藏一样是**用户自己的数据**
 * （所以**不写审计** —— 跟 `sessions.favorite` 保持一致）。
 *
 * ## 索引
 *
 * idx_messages_tenant_favorite (tenant_id, favorite) ——
 * 「只看收藏的消息」是这个查询的过滤条件，没索引会全表扫。
 * （当前还没有「只看收藏消息」的筛选页，索引是为将来留的，
 *   跟 `sessions.favorite` 的索引策略保持一致。）
 *
 * 幂等：列已存在就跳过。
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  const sequelize = queryInterface.sequelize;

  const [rows] = await sequelize.query<{ COLUMN_NAME: string }>(
    'SELECT COLUMN_NAME FROM information_schema.COLUMNS ' +
      'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    { replacements: ['messages', 'favorite'], type: QueryTypes.SELECT },
  );
  if (Array.isArray(rows) && rows.length > 0) {
    return;
  }

  await sequelize.query(
    'ALTER TABLE messages ADD COLUMN favorite BOOLEAN NOT NULL DEFAULT FALSE ' +
      "COMMENT '是否收藏（用户标记的重要回答）'",
  );
  await sequelize.query(
    'CREATE INDEX idx_messages_tenant_favorite ON messages (tenant_id, favorite)',
  );
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.query('DROP INDEX idx_messages_tenant_favorite ON messages');
  await queryInterface.sequelize.query('ALTER TABLE messages DROP COLUMN favorite');
};
