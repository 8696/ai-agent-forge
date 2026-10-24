import { Table, Column, Model, PrimaryKey, DataType, CreatedAt, Index } from 'sequelize-typescript';

/**
 * LLM 调用成本流水 —— D3（docs/12-d-需求-运维稳定.md §D3）
 *
 * 一行 = 一次 LLM 调用。用来回答两个问题：
 *   - 「本月用了多少 token」（租户预算闸门）
 *   - 「钱花在哪了」（哪次调用最贵）
 *
 * `cost` 是**估算**值（见 src/lib/cost-pricing.ts），不是账单金额；
 * 预算闸门按 `total_tokens` 走，不依赖这张表的金额精度。
 *
 * 主键 BIGINT AUTO_INCREMENT —— 不在模型上挂 @Default，
 * 否则类型对不上 autoIncrement，sync 时会和数据库冲突（跟 AuditLog 同理）。
 */
@Table({ tableName: 'cost_logs', timestamps: false })
export class CostLog extends Model {
  @PrimaryKey
  @Column({ type: DataType.BIGINT, autoIncrement: true })
  declare id: number;

  /** 所属租户 */
  @Index({ name: 'idx_cost_logs_tenant_created' })
  @Column({ type: DataType.STRING(36), allowNull: false })
  declare tenant_id: string;

  /** 触发调用的用户（系统内部调用可空） */
  @Column({ type: DataType.STRING(36), allowNull: true })
  declare user_id: string | null;

  /** 所属会话 */
  @Column({ type: DataType.STRING(36), allowNull: true })
  declare session_id: string | null;

  /** 关联的 assistant 消息 id */
  @Column({ type: DataType.STRING(36), allowNull: true })
  declare message_id: string | null;

  /** provider 标识（日志 / 审计用，不参与调用） */
  @Column({ type: DataType.STRING(32), allowNull: true })
  declare provider: string | null;

  /** 实际使用的模型 id */
  @Column({ type: DataType.STRING(100), allowNull: true })
  declare model: string | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare input_tokens: number;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare output_tokens: number;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare cache_read_tokens: number;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare cache_write_tokens: number;

  /** 合计 token = 输入 + 输出 + 缓存读 + 缓存写 */
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare total_tokens: number;

  /** 估算花费（USD） */
  @Column({ type: DataType.DECIMAL(12, 6), allowNull: false, defaultValue: 0 })
  declare cost: number;

  @CreatedAt
  @Column({ type: DataType.DATE(6) })
  declare created_at: Date;
}
