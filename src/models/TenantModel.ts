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
 * **每租户每个 usage_scope 恰有一条 is_active**，对话走 `chat` 那条，
 * 记忆抽取走 `memory` 那条（没配 memory 就回落到 chat 那条），
 * 会话摘要走 `summary` 那条（没配 summary 就回落到 chat 那条）。
 * 不变式由 activateTenantModel() 在一个事务里保证（先全灭，再亮新的）。
 * 每个 scope 的第一条模型入库时自动成为该 scope 的启用项 ——
 * 否则租户建了模型却没选中，对话只能一直走 .env 默认，用户会以为「配了没生效」。
 */
/**
 * 模型条目的用途 —— 决定这条模型服务于哪条链路
 *
 *  - `chat`   对话（主链路）
 *  - `memory` 记忆抽取（B4 长期记忆的后台抽取调用）
 *  - `summary` 会话摘要（B1 摘要压缩的后台摘要调用）
 *
 * 为什么是「用途」而不是「指针」：模型条目本身就是一套完整连接配置
 * （端点 + 密钥 + 采样参数），复用它 = 不引入第二套密钥管理，
 * 也不会出现「配置里指着一个已被删掉的模型 id」这种悬空引用。
 */
export type ModelUsageScope = 'chat' | 'memory' | 'summary';

export const MODEL_USAGE_SCOPES: readonly ModelUsageScope[] = ['chat', 'memory', 'summary'];

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

  /**
   * 用途：chat=对话模型 / memory=记忆抽取模型。
   *
   * 没配 memory 模型时，记忆抽取**回落到对话模型**（行为跟没加这个字段之前一样）。
   */
  @Default('chat')
  @Column({
    type: DataType.ENUM('chat', 'memory'),
    allowNull: false,
    defaultValue: 'chat',
  })
  declare usage_scope: ModelUsageScope;

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

  /**
   * 是否是该 scope 当前启用的模型。
   * 每个 scope 各自最多一条为 true（对话链路的 chat scope、抽取链路的 memory scope）。
   */
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