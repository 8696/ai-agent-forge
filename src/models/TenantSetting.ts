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
  Index,
} from 'sequelize-typescript';
import { nanoid } from 'nanoid';
import { Tenant } from './Tenant';

/**
 * 租户通用配置表（KV）—— DDL 见 docs/05-a-数据模型-mysql.md §租户通用配置表
 *
 * **存的是「租户改过的值」，不是「全部配置项」**：
 *   - 键的**元信息**（类型 / 名称 / 分类 / 默认值 / 取值范围）在代码里，
 *     见 src/services/tenant-settings.ts 的 SETTINGS_REGISTRY
 *   - 本表只存 tenant_id + config_key + config_value
 *
 * 这么切的理由：
 *  - 类型和范围校验必须有代码（zod），否则 KV 表会退化成人人可写的万能垃圾桶
 *  - 后台页面按 registry 渲染，改一个配置项不用动 SQL
 *  - 表结构稳定，将来加配置项只改 registry；租户没配过的键**根本不占行**
 *
 * 值统一存字符串（VARCHAR），按 registry 里的类型解析：
 * number / boolean / string。解析失败当作「没配」，回落到默认值并记 warn ——
 * 不能因为一个手滑存进去的坏值就让整个对话挂掉。
 */
@Table({ tableName: 'tenant_settings' })
export class TenantSetting extends Model {
  @PrimaryKey
  @Default(() => nanoid(21))
  @Column({ type: DataType.STRING(36) })
  declare id: string;

  @ForeignKey(() => Tenant)
  @Index({ name: 'uk_tenant_settings_key' })
  @Column({ type: DataType.STRING(36), allowNull: false })
  declare tenant_id: string;

  /** 配置项键，必须命中 SETTINGS_REGISTRY */
  @Column({ type: DataType.STRING(64), allowNull: false })
  declare config_key: string;

  /** 值（统一存字符串；类型由 registry 决定） */
  @Column({ type: DataType.STRING(1000), allowNull: false })
  declare config_value: string;

  @Column({ type: DataType.STRING(36), allowNull: true })
  declare updated_by: string | null;

  @CreatedAt
  @Column({ type: DataType.DATE(6) })
  declare created_at: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE(6) })
  declare updated_at: Date;

  @BeforeCreate
  static generateId(instance: TenantSetting): void {
    if (!instance.id) {
      instance.id = nanoid(21);
    }
  }
}