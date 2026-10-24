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
 * 评测题目 —— D1 评测
 *
 * `reference_answer` 可空：没有参考答案时裁判只能按「回答本身是否站得住」打分，
 * 准确性维度会退化成「有没有答非所问」。
 */
@Table({ tableName: 'evaluation_items', timestamps: false })
export class EvaluationItem extends Model {
  @PrimaryKey
  @Default(() => nanoid(21))
  @Column({ type: DataType.STRING(36) })
  declare id: string;

  @Index({ name: 'idx_eval_items_dataset' })
  @Column({ type: DataType.STRING(36), allowNull: false })
  declare dataset_id: string;

  @Column({ type: DataType.STRING(36), allowNull: false })
  declare tenant_id: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare question: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare reference_answer: string | null;

  @Column({ type: DataType.STRING(64), allowNull: true })
  declare scenario: string | null;

  @Column({ type: DataType.STRING(16), allowNull: true })
  declare difficulty: string | null;

  @CreatedAt
  @Column({ type: DataType.DATE(6) })
  declare created_at: Date;
}
