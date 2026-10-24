import {
  Table,
  Column,
  Model,
  PrimaryKey,
  Default,
  DataType,
  CreatedAt,
  Index,
} from 'sequelize-typescript';
import { nanoid } from 'nanoid';

/**
 * Trace —— D2 观测（docs/12-d-需求-运维稳定.md §D2）
 *
 * 一行 = 一次用户视角的交互（一次对话请求 / 一次评测里的单条问答）。
 * 里面挂了这条链路的关键指标：总耗时、token、成本、模型、状态。
 *
 * `cost` 是**估算**值（见 src/lib/cost-pricing.ts），不是账单金额。
 */
@Table({ tableName: 'traces', timestamps: false })
export class Trace extends Model {
  @PrimaryKey
  @Default(() => nanoid(21))
  @Column({ type: DataType.STRING(36) })
  declare id: string;

  @Index({ name: 'idx_traces_tenant_started' })
  @Column({ type: DataType.STRING(36), allowNull: false })
  declare tenant_id: string;

  /** 触发用户；系统内部调用（评测 / 后台任务）为 null */
  @Index({ name: 'idx_traces_user' })
  @Column({ type: DataType.STRING(36), allowNull: true })
  declare user_id: string | null;

  @Index({ name: 'idx_traces_session' })
  @Column({ type: DataType.STRING(36), allowNull: true })
  declare session_id: string | null;

  /** trace 名（如 chat.message） */
  @Column({ type: DataType.STRING(100), allowNull: false })
  declare name: string;

  /** trace 类型：chat / api / evaluation */
  @Column({ type: DataType.STRING(32), allowNull: false, defaultValue: 'chat' })
  declare kind: string;

  /** success / error */
  @Column({ type: DataType.STRING(16), allowNull: false, defaultValue: 'success' })
  declare status: string;

  /** 接入渠道（web / widget / api） */
  @Column({ type: DataType.STRING(32), allowNull: true })
  declare channel: string | null;

  @Column({ type: DataType.STRING(32), allowNull: true })
  declare provider: string | null;

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

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare total_tokens: number;

  /** 估算花费（USD） */
  @Column({ type: DataType.DECIMAL(12, 6), allowNull: false, defaultValue: 0 })
  declare cost: number;

  /** 总耗时（毫秒） */
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare duration_ms: number | null;

  /** 失败原因摘要（不记堆栈，避免把内部细节写进库） */
  @Column({ type: DataType.STRING(500), allowNull: true })
  declare error_message: string | null;

  @Column({ type: DataType.JSON, allowNull: true })
  declare metadata: Record<string, unknown> | null;

  @Column({ type: DataType.DATE(6), allowNull: false })
  declare started_at: Date;

  @Column({ type: DataType.DATE(6), allowNull: true })
  declare ended_at: Date | null;

  @CreatedAt
  @Column({ type: DataType.DATE(6) })
  declare created_at: Date;
}
