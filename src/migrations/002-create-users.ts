import { DataTypes, type QueryInterface } from 'sequelize';
import type { MigrationFn } from 'umzug';

/**
 * 创建 users 表 —— 对应 docs/05-a-数据模型-mysql.md §5.1 的 DDL
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.createTable('users', {
    id: {
      type: DataTypes.STRING(36),
      primaryKey: true,
      comment: 'UUID',
    },
    tenant_id: {
      type: DataTypes.STRING(36),
      allowNull: false,
      comment: '所属租户（冗余存；查询时强制加 where 过滤）',
    },
    email: {
      type: DataTypes.STRING(255),
      allowNull: false,
      comment: '登录邮箱；同租户内唯一',
    },
    password_hash: {
      type: DataTypes.STRING(255),
      allowNull: true,
      comment: 'bcrypt hash（cost=12）',
    },
    role: {
      type: DataTypes.ENUM('admin', 'agent', 'customer'),
      allowNull: false,
      comment: '3 个角色；不做权限矩阵',
    },
    preferences: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: '用户偏好（长期记忆）',
    },
    must_change_password: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment: '首次登录强制改密码',
    },
    failed_login_count: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: '登录失败计数（防暴力）',
    },
    locked_until: {
      type: DataTypes.DATE(6),
      allowNull: true,
      comment: '账号锁定截止时间；NULL 不锁定',
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

  // 唯一键 + 普通索引
  await queryInterface.addIndex('users', ['email', 'tenant_id'], {
    name: 'uk_users_email_per_tenant',
    unique: true,
  });
  await queryInterface.addIndex('users', ['tenant_id', 'role'], { name: 'idx_users_tenant_role' });

  // 外键
  await queryInterface.addConstraint('users', {
    fields: ['tenant_id'],
    type: 'foreign key',
    name: 'fk_users_tenant',
    references: { table: 'tenants', field: 'id' },
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  await queryInterface.sequelize.query("ALTER TABLE users COMMENT = '用户表（含后台 + 前台）'");
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.dropTable('users');
};
