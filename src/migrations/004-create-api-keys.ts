import { DataTypes, type QueryInterface } from 'sequelize';
import type { MigrationFn } from 'umzug';

/**
 * 创建 api_keys 表 —— 对应 docs/05-a-数据模型-mysql.md §5.1
 * 租户 API 密钥；DB 只存 hash，完整 key 仅创建时返回一次
 *
 * API key 的生成 / 吊销 / 校验端点本身在 E1（Step 9+），Step 2 只建表
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.createTable('api_keys', {
    id: {
      type: DataTypes.STRING(36),
      primaryKey: true,
      comment: 'UUID',
    },
    tenant_id: {
      type: DataTypes.STRING(36),
      allowNull: false,
      comment: '所属租户',
    },
    name: {
      type: DataTypes.STRING(100),
      allowNull: false,
      comment: '租户自己起的名字（"生产环境 / 测试环境"）',
    },
    key_prefix: {
      type: DataTypes.STRING(10),
      allowNull: false,
      comment: 'key 前 8 位（用于 UI 显示识别，不存完整 key）',
    },
    key_hash: {
      type: DataTypes.STRING(255),
      allowNull: false,
      comment: '完整 key 的 bcrypt hash',
    },
    last_used_at: {
      type: DataTypes.DATE(6),
      allowNull: true,
      comment: '最后使用时间',
    },
    expires_at: {
      type: DataTypes.DATE(6),
      allowNull: true,
      comment: '过期时间；NULL = 不过期',
    },
    revoked_at: {
      type: DataTypes.DATE(6),
      allowNull: true,
      comment: '撤销时间（软删除）',
    },
    created_by: {
      type: DataTypes.STRING(36),
      allowNull: false,
      comment: '哪个 admin 创建的',
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

  await queryInterface.addIndex('api_keys', ['tenant_id', 'created_at'], {
    name: 'idx_api_keys_tenant_created',
  });
  await queryInterface.addIndex('api_keys', ['tenant_id', 'key_prefix'], {
    name: 'idx_api_keys_tenant_prefix',
  });

  // 外键：tenant_id -> tenants.id
  await queryInterface.addConstraint('api_keys', {
    fields: ['tenant_id'],
    type: 'foreign key',
    name: 'fk_api_keys_tenant',
    references: { table: 'tenants', field: 'id' },
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  // 外键：created_by -> users.id
  await queryInterface.addConstraint('api_keys', {
    fields: ['created_by'],
    type: 'foreign key',
    name: 'fk_api_keys_created_by',
    references: { table: 'users', field: 'id' },
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
  });

  await queryInterface.sequelize.query("ALTER TABLE api_keys COMMENT = '租户 API 密钥'");
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.dropTable('api_keys');
};
