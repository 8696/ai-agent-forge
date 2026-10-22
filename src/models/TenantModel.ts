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
 * 租户模型配置表（DDL 见 docs/05-a-数据模型-mysql.md §租户模型表）
 *
 * **一个租户可以配多个模型**，逐条切换——「自建网关 + 官方 API 并存」
 * 「快模型草稿 / 慢模型正式」这类场景都能覆盖。
 *
 * 每条都是**完整的连接配置**（端点 + 密钥 + 采样参数），不跟别的条目共享：
 * 共享的代价是「换个模型还得复制一遍网关和密钥」，配置一多就乱。
 *
 * **每租户恰有一条 is_active**，对话走它。不变式由 activateTenantModel()
 * 在一个事务里保证（先全灭，再亮新的）。第一条模型入库时自动成为启用项 ——
 * 否则租户建了模型却没选中，对话只能一直走 .env 默认，用户会以为「配了没生效」。
 */
@Table({ tableName: 'tenant_models' })
export class TenantModel extends Model {
  @PrimaryKey
  @Default(() => nanoid(21))
  @Column({ type: DataType.STRING(36) })
  declare id: string;

  @ForeignKey(() => Tenant)
  @Index({ name: 'idx_tenant_models_tenant' })
  @Column({ type: DataType.STRING(36), allowNull: false })
  declare tenant_id: string;

  /** 条目名（租户自定义，如「生产-快」「测试-慢」），对话链路不关心 */
  @Column({ type: DataType.STRING(100), allowNull: false })
  declare name: string;

  /** 展示用标识（zhipu / openai-compatible / 自填），不参与调用 */
  @Column({ type: DataType.STRING(32), allowNull: true })
  declare provider: string | null;

  @Column({ type: DataType.STRING(100), allowNull: false })
  declare model_id: string;

  /** Anthropic 协议端点（存储时已 normalize 成以 /v1 结尾） */
  @Column({ type: DataType.STRING(500), allowNull: false })
  declare base_url: string;

  /** AES-256-GCM 密文：iv(12) + authTag(16) + ciphertext。密钥 = CONFIG_ENCRYPTION_KEY */
  @Column({ type: DataType.BLOB, allowNull: false })
  declare api_key_enc: Buffer;

  /** 脱敏提示（sk-…4f2a），**唯一**允许回显给前端的密钥形态 */
  @Column({ type: DataType.STRING(64), allowNull: true })
  declare api_key_hint: string | null;

  @Column({ type: DataType.DECIMAL(3, 2), allowNull: true })
  declare temperature: number | null;

  @Column({ type: DataType.INTEGER, allowNull: true })
  declare max_output_tokens: number | null;

  /** 是否给系统提示词打 cacheControl（docs/04-c §5.4.1） */
  @Default(true)
  @Column({ type: DataType.BOOLEAN, allowNull: false })
  declare prompt_cache_enabled: boolean;

  /** 是否是对话当前使用的模型。每租户恰有一条为 true */
  @Default(false)
  @Column({ type: DataType.BOOLEAN, allowNull: false })
  declare is_active: boolean;

  @Column({ type: DataType.STRING(36), allowNull: true })
  declare updated_by: string | null;

  @CreatedAt
  @Column({ type: DataType.DATE(6) })
  declare created_at: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE(6) })
  declare updated_at: Date;

  @BeforeCreate
  static generateId(instance: TenantModel): void {
    if (!instance.id) {
      instance.id = nanoid(21);
    }
  }
}