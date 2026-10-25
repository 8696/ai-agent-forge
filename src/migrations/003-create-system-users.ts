import { DataTypes, type QueryInterface } from 'sequelize';
import type { MigrationFn } from 'umzug';

/**
 * 创建 system_users 表 —— 对应 docs/05-a-数据模型-mysql.md §5.1
 * SaaS 平台方自己的账号，**跨租户**用，不带 tenant_id
 *
 * 注意：第一个 system_users 用 SQL 手工建（docs/05 §5.1 末尾备注），
 * 此迁移只建空表，不插种子数据。
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.createTable('system_users', {
    id: {
      type: DataTypes.STRING(36),
      primaryKey: true,
      comment: 'UUID',
    },
    email: {
      type: DataTypes.STRING(255),
      allowNull: false,
      unique: true,
      comment: '系统级管理员邮箱（唯一）',
    },
    password_hash: {
      type: DataTypes.STRING(255),
      allowNull: false,
      comment: 'bcrypt hash',
    },
    name: {
      type: DataTypes.STRING(100),
      allowNull: true,
      comment: '显示名',
    },
    role: {
      type: DataTypes.ENUM('system'),
      allowNull: false,
      defaultValue: 'system',
      comment: '唯一角色：system',
    },
    failed_login_count: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: '登录失败计数',
    },
    locked_until: {
      type: DataTypes.DATE(6),
      allowNull: true,
      comment: '账号锁定截止时间',
    },
    last_login_at: {
      type: DataTypes.DATE(6),
      allowNull: true,
      comment: '最后登录时间',
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

  await queryInterface.sequelize.query(
    "ALTER TABLE system_users COMMENT = '系统超级管理员（建租户）'",
  );
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.dropTable('system_users');
};
