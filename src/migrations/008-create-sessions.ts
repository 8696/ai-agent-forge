import { DataTypes, type QueryInterface } from 'sequelize';
import type { MigrationFn } from 'umzug';

/**
 * Step 7 · 多轮对话 —— 建 `sessions` 表
 * 详见 docs/05-a-数据模型-mysql.md §5.1 + docs/15-开发进度计划.md §Step 7 + docs/16-b §B1/B4
 *
 * 关键设计：
 *  - 冗余存 `tenant_id`：消息历史按租户翻页 + 跨租户统计都常用
 *  - `user_id` 允许 NULL：公开挂件（匿名访问）的会话不属于任何租户用户
 *  - `channel` ENUM('widget','email','api')：渠道区分；本期 MVP 只用 'widget' 和 'api'
 *  - `title`：第一条 user message 前 20 字（自动生成；消息入库后回填）
 *  - `summary`：超长会话摘要压缩结果（Step 7 自动维护）
 *  - `metadata` JSON：渠道元信息（client UA / 来源 referrer 等）
 *  - 索引 idx_tenant_started：后台按租户 + 时间翻页
 *  - 索引 idx_user：前台用户看自己的历史
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.createTable('sessions', {
    id: {
      type: DataTypes.STRING(36),
      primaryKey: true,
      comment: 'UUID',
    },
    tenant_id: {
      type: DataTypes.STRING(36),
      allowNull: false,
      comment: '所属租户',
      references: { model: 'tenants', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    user_id: {
      type: DataTypes.STRING(36),
      allowNull: true,
      comment: '前台用户 ID；公开挂件为 NULL',
      references: { model: 'users', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    },
    channel: {
      type: DataTypes.ENUM('widget', 'email', 'api'),
      allowNull: false,
      comment: '接入渠道',
    },
    status: {
      type: DataTypes.ENUM('active', 'closed', 'transferred'),
      allowNull: false,
      defaultValue: 'active',
      comment: '会话状态',
    },
    title: {
      type: DataTypes.STRING(200),
      allowNull: true,
      comment: '第一条用户消息的前 20 字（自动生成）',
    },
    summary: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: '摘要压缩后的内容（超长会话用）',
    },
    metadata: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: '渠道 / 来源 / 客户端信息',
    },
    started_at: {
      type: DataTypes.DATE(6),
      allowNull: false,
      defaultValue: queryInterface.sequelize.literal('CURRENT_TIMESTAMP(6)'),
      comment: '开始时间',
    },
    ended_at: {
      type: DataTypes.DATE(6),
      allowNull: true,
      comment: '结束时间（NULL 表示进行中）',
    },
  });

  await queryInterface.addIndex('sessions', ['tenant_id', 'started_at'], {
    name: 'idx_sessions_tenant_started',
  });
  await queryInterface.addIndex('sessions', ['user_id'], {
    name: 'idx_sessions_user',
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.dropTable('sessions');
};
