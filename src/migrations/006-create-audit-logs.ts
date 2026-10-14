import { DataTypes, type QueryInterface } from 'sequelize';
import type { MigrationFn } from 'umzug';

/**
 * Step 15（F2 提前落地 audit_logs 表）—— 详见 docs/05-a-数据模型-mysql.md §5.1
 *
 * 设计原则：
 *  - audit_logs 既被 F2 写（TENANT_STATUS_CHANGE / TENANT_EXPIRES_CHANGE），
 *    也被 Step 12（D5 审计）大量写入。
 *  - 系统级日志：`tenant_id IS NULL`（SaaS 平台方在 system 子系统里的写操作）。
 *  - 不加外键：跨子系统查询场景多，外键会拖累 INSERT 性能且不易回滚。
 *  - action 不做 ENUM 强约束，方便后续 Step 12 直接扩展（如 LOGIN_FAILURE / CONFIG_CHANGE 等）。
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.createTable('audit_logs', {
    id: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      autoIncrement: true,
      comment: '自增 ID（按 D5 §5.1 设计）',
    },
    tenant_id: {
      type: DataTypes.STRING(36),
      allowNull: true,
      comment: '所属租户；系统级日志 = NULL（system 子系统操作）',
    },
    user_id: {
      type: DataTypes.STRING(36),
      allowNull: true,
      comment: '触发操作的用户（system 操作取 system_user.id）',
    },
    action: {
      type: DataTypes.STRING(100),
      allowNull: false,
      comment: '操作类型（TENANT_STATUS_CHANGE / TENANT_EXPIRES_CHANGE / ...）',
    },
    resource_type: {
      type: DataTypes.STRING(100),
      allowNull: true,
      comment: '资源类型（user / document / settings / tenant ...）',
    },
    resource_id: {
      type: DataTypes.STRING(36),
      allowNull: true,
      comment: '资源 ID',
    },
    details: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: '操作详情（前后值 / 失败原因）',
    },
    ip: {
      type: DataTypes.STRING(45),
      allowNull: true,
      comment: '客户端 IP（IPv6 最长 45 字符）',
    },
    created_at: {
      type: DataTypes.DATE(6),
      allowNull: false,
      defaultValue: queryInterface.sequelize.literal('CURRENT_TIMESTAMP(6)'),
    },
  });

  // 索引：按租户 + 时间翻页（审计页最常见的查询模式）
  await queryInterface.addIndex('audit_logs', ['tenant_id', 'created_at'], {
    name: 'idx_audit_logs_tenant_created',
  });
  // 索引：按 action 统计（D5 告警会用到）
  await queryInterface.addIndex('audit_logs', ['action', 'created_at'], {
    name: 'idx_audit_logs_action_created',
  });

  await queryInterface.sequelize.query(
    "ALTER TABLE audit_logs COMMENT = '审核日志（所有关键操作）'",
  );
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.dropTable('audit_logs');
};
