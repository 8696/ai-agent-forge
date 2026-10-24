import { DataTypes, type QueryInterface } from 'sequelize';
import type { MigrationFn } from 'umzug';

/**
 * LLM 调用成本流水表 —— D3（docs/12-d-需求-运维稳定.md §D3）
 *
 * 一行 = 一次 LLM 调用。租户月度预算闸门按 `total_tokens` 累计，
 * `cost` 是按内置价格表估出来的美元数（见 src/lib/cost-pricing.ts）。
 *
 * 索引：
 *  - (tenant_id, created_at) —— 「本月用了多少」的主查询
 *  - (session_id) —— 按会话查这次会话花了多少
 *
 * 不加外键：跟 audit_logs 一样，跨子系统查询多，外键会拖累写入。
 * 级联删除靠应用层（删会话时不删成本流水 —— 成本是账，删了就没法审计了）。
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.createTable('cost_logs', {
    id: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      autoIncrement: true,
      comment: '自增 ID',
    },
    tenant_id: {
      type: DataTypes.STRING(36),
      allowNull: false,
      comment: '所属租户',
    },
    user_id: {
      type: DataTypes.STRING(36),
      allowNull: true,
      comment: '触发调用的用户',
    },
    session_id: {
      type: DataTypes.STRING(36),
      allowNull: true,
      comment: '所属会话',
    },
    message_id: {
      type: DataTypes.STRING(36),
      allowNull: true,
      comment: '关联的 assistant 消息 id',
    },
    provider: {
      type: DataTypes.STRING(32),
      allowNull: true,
      comment: 'provider 标识（zhipu / minimax / ...）',
    },
    model: {
      type: DataTypes.STRING(100),
      allowNull: true,
      comment: '实际使用的模型 id',
    },
    input_tokens: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: '输入 token',
    },
    output_tokens: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: '输出 token',
    },
    cache_read_tokens: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: '缓存命中（读取）token',
    },
    cache_write_tokens: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: '缓存写入 token',
    },
    total_tokens: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: '合计 token（预算闸门按这个算）',
    },
    cost: {
      type: DataTypes.DECIMAL(12, 6),
      allowNull: false,
      defaultValue: 0,
      comment: '估算花费（USD）；模型不在价格表里时为 0 = 未知',
    },
    created_at: {
      type: DataTypes.DATE(6),
      allowNull: false,
      defaultValue: queryInterface.sequelize.literal('CURRENT_TIMESTAMP(6)'),
      comment: '调用时间',
    },
  });

  await queryInterface.addIndex('cost_logs', ['tenant_id', 'created_at'], {
    name: 'idx_cost_logs_tenant_created',
  });
  await queryInterface.addIndex('cost_logs', ['session_id'], {
    name: 'idx_cost_logs_session',
  });

  await queryInterface.sequelize.query(
    "ALTER TABLE cost_logs COMMENT = 'LLM 调用成本流水（一行一次调用）'",
  );
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.dropTable('cost_logs');
};
