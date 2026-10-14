import {
  Table,
  Column,
  Model,
  PrimaryKey,
  Default,
  DataType,
  CreatedAt,
  UpdatedAt,
  BeforeCreate,
  ForeignKey,
  BelongsTo,
} from 'sequelize-typescript';
import { nanoid } from 'nanoid';
import { Tenant } from './Tenant';

/**
 * 用户角色：与 docs/05-数据模型.md §5.1 一致
 * - admin 后台管理员
 * - agent 后台客服坐席
 * - customer 前台用户
 */
export type UserRole = 'admin' | 'customer';

/**
 * 用户偏好（JSON 列），存长期记忆
 */
export interface UserPreferences {
  language?: string;
  timezone?: string;
  [key: string]: unknown;
}

/**
 * 用户表，含后台 + 前台（DDL 见 docs/05-数据模型.md §5.1）
 * - `(email, tenant_id)` 唯一：同租户内邮箱不重复
 * - 跨租户可能同邮箱，靠 `tenant_id` 区分
 */
@Table({ tableName: 'users' })
export class User extends Model {
  @PrimaryKey
  @Default(() => nanoid(21))
  @Column({ type: DataType.STRING(36) })
  declare id: string;

  @ForeignKey(() => Tenant)
  @Column({ type: DataType.STRING(36), allowNull: false })
  declare tenant_id: string;

  @Column({ type: DataType.STRING(255), allowNull: false })
  declare email: string;

  @Column({ type: DataType.STRING(255), allowNull: true })
  declare password_hash: string | null;

  @Column({ type: DataType.ENUM('admin', 'agent', 'customer'), allowNull: false })
  declare role: UserRole;

  @Column({ type: DataType.JSON })
  declare preferences: UserPreferences | null;

  @Default(false)
  @Column({ type: DataType.BOOLEAN })
  declare must_change_password: boolean;

  @Default(0)
  @Column({ type: DataType.INTEGER })
  declare failed_login_count: number;

  @Column({ type: DataType.DATE(6) })
  declare locked_until: Date | null;

  @Column({ type: DataType.DATE(6) })
  declare last_login_at: Date | null;

  @CreatedAt
  @Column({ type: DataType.DATE(6) })
  declare created_at: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE(6) })
  declare updated_at: Date;

  // 关联（多对一）
  @BelongsTo(() => Tenant)
  declare tenant?: Tenant;

  @BeforeCreate
  static generateId(instance: User): void {
    if (!instance.id) {
      instance.id = nanoid(21);
    }
  }
}
