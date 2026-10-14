import { DataTypes, type QueryInterface } from 'sequelize';
import type { MigrationFn } from 'umzug';

/**
 * Step 15 / F2 —— 给 tenants 表加 status / expires_at 字段 + 复合索引
 * 详见 docs/05-a-数据模型-mysql.md §5.1（tenants 表）
 *
 * 语义：
 *  - status:    ENUM('active','disabled') DEFAULT 'active'。disabled 的租户在
 *               admin/customer login 闸门处拒绝（统一 401「邮箱或密码错误」防枚举）。
 *               code='system' 的初始租户禁止 PATCH 改 disabled（防 SaaS 平台方自锁）。
 *  - expires_at: DATETIME(6) NULL。NULL = 永不过；非 NULL 且 <= 当前时刻 → 同样闸门拒绝。
 *  - idx_status_expires: 复合索引，加速登录时的「status + expires_at 过滤」。
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  // 1. 加 status 列
  await queryInterface.addColumn('tenants', 'status', {
    type: DataTypes.ENUM('active', 'disabled'),
    allowNull: false,
    defaultValue: 'active',
    comment: 'F2 配套：disabled 禁止 admin/customer 登录',
  });

  // 2. 加 expires_at 列
  await queryInterface.addColumn('tenants', 'expires_at', {
    type: DataTypes.DATE(6),
    allowNull: true,
    comment: 'F2 配套：NULL = 永不过期；到期后禁止 admin/customer 登录',
  });

  // 3. 复合索引 —— 登录时按 (status, expires_at) 过滤
  await queryInterface.addIndex('tenants', ['status', 'expires_at'], {
    name: 'idx_tenants_status_expires',
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.removeIndex('tenants', 'idx_tenants_status_expires');
  await queryInterface.removeColumn('tenants', 'expires_at');
  await queryInterface.removeColumn('tenants', 'status');
};
