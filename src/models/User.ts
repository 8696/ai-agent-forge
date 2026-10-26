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
 * 用户角色：与 docs/05-a-数据模型-mysql.md §5.1 一致
 * - admin 后台管理员
 * - agent 后台客服坐席
 * - customer 前台用户
 */
export type UserRole = 'admin' | 'customer';

/**
 * 用户偏好（JSON 列），存长期记忆
 *
 * ⚠️ 记忆**条目本体**不在这里，而在 `user_memories` 表（见 src/models/UserMemory.ts）——
 * 那边要支持逐条列出 / 编辑 / 删除 / 归档 / 记来源和置信度。
 * 这个 JSON 列只存「跟这个用户有关、但不是记忆条目本身」的零散偏好，
 * 其中 `memory_enabled` 是长期记忆的总开关（用户在「我的记忆」页自己关）。
 */
export interface UserPreferences {
  language?: string;
  timezone?: string;
  /** 是否开启自动记忆（抽取 + 注入）。缺省视为开启 */
  memory_enabled?: boolean;
  [key: string]: unknown;
}

/**
 * 用户表，含后台 + 前台（DDL 见 docs/05-a-数据模型-mysql.md §5.1）
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

  /**
   * 角色。
   *
   * ⚠️ **数据库列的 ENUM 里有三个值，但只有两个能用**：
   * `agent` 是历史留位（早期设想的后台客服坐席），本产品**没有这个角色** ——
   * `roleSchema`（`src/lib/validators.ts`）只收 `admin` / `customer`，
   * 传 `agent` 直接 400，代码层面也拒收它登录任何子系统。
   * 列里保留它是为了不动历史数据（见 12-a §A3）。
   */
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
