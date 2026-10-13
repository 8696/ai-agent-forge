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
 * 租户可用的套餐档位
 */
export type TenantPlan = 'free' | 'pro' | 'enterprise';

/**
 * tenants.settings JSON 列内允许存放的键（运行时会保持 forward-compat，多余键透传）
 */
export interface TenantSettings {
  prompt_version?: string;
  model?: string;
  temperature?: number;
  monthly_token_budget?: number;
  language?: string;
  [key: string]: unknown;
}

/**
 * 租户主表（DDL 见 docs/05-数据模型.md §5.1）
 * - 租户号 `code` 全局唯一，是登录 + 挂件 URL 的入口
 * - `settings` 用 MySQL JSON 列存租户级配置（提示词版本、模型、限额等）
 */
@Table({ tableName: 'tenants' })
export class Tenant extends Model {
  @PrimaryKey
  @Default(() => nanoid(21))
  @Column({ type: DataType.STRING(36) })
  declare id: string;

  @Column({ type: DataType.STRING(32), allowNull: false, unique: true })
  declare code: string;

  @Column({ type: DataType.STRING(200), allowNull: false })
  declare name: string;

  @Default('free')
  @Column({ type: DataType.ENUM('free', 'pro', 'enterprise') })
  declare plan: TenantPlan;

  @Column({ type: DataType.JSON })
  declare settings: TenantSettings | null;

  @Column({ type: DataType.STRING(255) })
  declare api_key_hash: string | null;

  @CreatedAt
  @Column({ type: DataType.DATE(6) })
  declare created_at: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE(6) })
  declare updated_at: Date;

  @BeforeCreate
  static generateId(instance: Tenant): void {
    if (!instance.id) {
      instance.id = nanoid(21);
    }
  }
}
