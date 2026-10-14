import { Table, Column, Model, PrimaryKey, DataType, CreatedAt } from 'sequelize-typescript';

/**
 * 操作类型枚举（F2 引入 + Step 12 会扩充）
 *  - TENANT_STATUS_CHANGE   F2：租户 status 被 SaaS 平台方改成 active/disabled
 *  - TENANT_EXPIRES_CHANGE  F2：租户 expires_at 被 SaaS 平台方改写（包括清空）
 *  - LOGIN_FAILURE ...      Step 12 引入
 *  - CONFIG_CHANGE ...      Step 12 引入
 *  ...
 */
export type AuditAction = 'TENANT_STATUS_CHANGE' | 'TENANT_EXPIRES_CHANGE';

/**
 * 审计日志表 —— 详见 docs/05-a-数据模型-mysql.md §5.1
 *
 * 系统级日志（`tenant_id IS NULL`）表示不属于任何租户的操作，例如：
 *  - SaaS 平台方在 system 子系统里的所有写操作（F2 的 TENANT_*_CHANGE 即此类）
 *  - 登录失败 / 限流命中 / 配置变更等（Step 12 扩充）
 *
 * 注意：本表在 F2（Step 15）首次落地；D5 完整审计由 Step 12 全量上线。
 *
 * 主键 BIGINT AUTO_INCREMENT（见迁移 006）—— 不要在模型上挂 @Default，
 * 否则类型对不上 autoIncrement，sync 时会和数据库冲突。
 *
 * `timestamps: false` 关掉 createdAt / updatedAt 自动维护 —— 审计日志 append-only，
 * 不会有 UPDATE，D5 字段只有 created_at，不要 updated_at（spec 见 05-a §5.1）。
 */
@Table({ tableName: 'audit_logs', timestamps: false })
export class AuditLog extends Model {
  /** 自增 BIGINT 主键（D5 字段，注释同 §5.1） */
  @PrimaryKey
  @Column({ type: DataType.BIGINT, autoIncrement: true })
  declare id: number;

  /**
   * 所属租户。系统级日志（system 子系统操作）= NULL。
   * 不加外键，方便跨子系统查。
   */
  @Column({ type: DataType.STRING(36), allowNull: true })
  declare tenant_id: string | null;

  /** 触发操作的用户 ID；system 操作取 system_user.id */
  @Column({ type: DataType.STRING(36), allowNull: true })
  declare user_id: string | null;

  /** 操作类型（与 AuditAction 对齐；写入时不强校验，方便以后扩展） */
  @Column({ type: DataType.STRING(100), allowNull: false })
  declare action: string;

  /** 资源类型（'user' / 'document' / 'settings' / 'tenant' ...） */
  @Column({ type: DataType.STRING(100), allowNull: true })
  declare resource_type: string | null;

  /** 资源 ID */
  @Column({ type: DataType.STRING(36), allowNull: true })
  declare resource_id: string | null;

  /** 操作详情（JSON；改了什么前后值等） */
  @Column({ type: DataType.JSON, allowNull: true })
  declare details: unknown;

  /** 客户端 IP（IPv6 最长 45 字符） */
  @Column({ type: DataType.STRING(45), allowNull: true })
  declare ip: string | null;

  @CreatedAt
  @Column({ type: DataType.DATE(6) })
  declare created_at: Date;
}
