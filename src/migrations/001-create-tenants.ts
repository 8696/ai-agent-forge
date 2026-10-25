import { DataTypes, type QueryInterface } from 'sequelize';
import type { MigrationFn } from 'umzug';

/**
 * 创建 tenants 表 —— 对应 docs/05-a-数据模型-mysql.md §5.1 的 DDL
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.createTable('tenants', {
    id: {
      type: DataTypes.STRING(36),
      primaryKey: true,
      comment: 'UUID',
    },
    code: {
      type: DataTypes.STRING(32),
      allowNull: false,
      unique: true,
      comment: '租户号，全局唯一；登录 / 挂件 URL 用',
    },
    name: {
      type: DataTypes.STRING(200),
      allowNull: false,
      comment: '租户显示名',
    },
    plan: {
      type: DataTypes.ENUM('free', 'pro', 'enterprise'),
      allowNull: false,
      defaultValue: 'free',
      comment: '套餐',
    },
    settings: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: '租户级配置（prompt_version / model / 限额等）',
    },
    api_key_hash: {
      type: DataTypes.STRING(255),
      allowNull: true,
      comment: '租户 API 密钥 bcrypt hash',
    },
    created_at: {
      type: DataTypes.DATE(6),
      allowNull: false,
      defaultValue: queryInterface.sequelize.literal('CURRENT_TIMESTAMP(6)'),
    },
    updated_at: {
      type: DataTypes.DATE(6),
      allowNull: false,
      defaultValue: queryInterface.sequelize.literal(
        'CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)',
      ),
    },
  });
  // 索引
  await queryInterface.addIndex('tenants', ['code'], { name: 'idx_tenants_code' });
  await queryInterface.addIndex('tenants', ['plan'], { name: 'idx_tenants_plan' });
  await queryInterface.sequelize.query("ALTER TABLE tenants COMMENT = '租户主表'");
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.dropTable('tenants');
};
