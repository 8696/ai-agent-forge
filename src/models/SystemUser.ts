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
} from 'sequelize-typescript';
import { nanoid } from 'nanoid';

/**
 * 系统超级管理员角色 —— 与 docs/05-数据模型.md §5.1 system_users 一致
 * 当前只有 system 一种（建租户 / 跨租户运营）
 */
export type SystemUserRole = 'system';

/**
 * 系统超级管理员表（docs/05 §5.1）
 * - **跨租户**操作（建租户、查任意租户运营数据）
 * - 没有 tenant_id
 * - 第一个 system_users 用 SQL 手工插（docs/05 §5.1 末尾备注）
 */
@Table({ tableName: 'system_users' })
export class SystemUser extends Model {
  @PrimaryKey
  @Default(() => nanoid(21))
  @Column({ type: DataType.STRING(36) })
  declare id: string;

  @Column({ type: DataType.STRING(255), allowNull: false, unique: true })
  declare email: string;

  @Column({ type: DataType.STRING(255), allowNull: false })
  declare password_hash: string;

  @Column({ type: DataType.STRING(100) })
  declare name: string | null;

  @Default('system')
  @Column({ type: DataType.ENUM('system') })
  declare role: SystemUserRole;

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

  @BeforeCreate
  static generateId(instance: SystemUser): void {
    if (!instance.id) {
      instance.id = nanoid(21);
    }
  }
}
