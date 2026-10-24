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
 * Span —— D2 观测（docs/12-d-需求-运维稳定.md §D2）
 *
 * 一行 = 调用链里的一步。详情页的时间线就是按 started_at 排序的 span 列表。
 *
 * `input` / `output` 只放**摘要**（条数、命中数、token 数之类），
 * 不放正文 —— 正文在 messages 表里，这里再存一份等于把敏感数据复制一遍。
 */
@Table({ tableName: 'spans', timestamps: false })
export class Span extends Model {
  @PrimaryKey
  @Default(() => nanoid(21))
  @Column({ type: DataType.STRING(36) })
  declare id: string;

  @Index({ name: 'idx_spans_trace' })
  @Column({ type: DataType.STRING(36), allowNull: false })
  declare trace_id: string;

  @Index({ name: 'idx_spans_tenant_started' })
  @Column({ type: DataType.STRING(36), allowNull: false })
  declare tenant_id: string;

  @Column({ type: DataType.STRING(36), allowNull: true })
  declare parent_span_id: string | null;

  /** span 名（如 retrieval.search / llm.generate） */
  @Column({ type: DataType.STRING(100), allowNull: false })
  declare name: string;

  /** http / retrieval / llm / guard / cost / storage */
  @Column({ type: DataType.STRING(32), allowNull: false, defaultValue: 'step' })
  declare kind: string;

  /** success / error */
  @Column({ type: DataType.STRING(16), allowNull: false, defaultValue: 'success' })
  declare status: string;

  @Column({ type: DataType.INTEGER, allowNull: true })
  declare duration_ms: number | null;

  /** 入参摘要 */
  @Column({ type: DataType.JSON, allowNull: true })
  declare input: Record<string, unknown> | null;

  /** 出参摘要 */
  @Column({ type: DataType.JSON, allowNull: true })
  declare output: Record<string, unknown> | null;

  @Column({ type: DataType.STRING(500), allowNull: true })
  declare error_message: string | null;

  @Column({ type: DataType.DATE(6), allowNull: false })
  declare started_at: Date;

  @Column({ type: DataType.DATE(6), allowNull: true })
  declare ended_at: Date | null;

  @CreatedAt
  @Column({ type: DataType.DATE(6) })
  declare created_at: Date;
}
