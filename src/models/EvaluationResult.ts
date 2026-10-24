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
 * 评测打分明细 —— D1 评测
 *
 * 一行 = 一条题目的「回答 + 打分 + 裁判理由」。
 * 页面点开一次跑批就能看到每条为什么是这个分。
 */

/** 四维分数（各 0~5） */
export interface EvaluationScores {
  accuracy: number;
  completeness: number;
  style: number;
  safety: number;
}

@Table({ tableName: 'evaluation_results', timestamps: false })
export class EvaluationResult extends Model {
  @PrimaryKey
  @Default(() => nanoid(21))
  @Column({ type: DataType.STRING(36) })
  declare id: string;

  @Index({ name: 'idx_eval_results_run' })
  @Column({ type: DataType.STRING(36), allowNull: false })
  declare run_id: string;

  @Column({ type: DataType.STRING(36), allowNull: false })
  declare tenant_id: string;

  @Column({ type: DataType.STRING(36), allowNull: true })
  declare item_id: string | null;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare question: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare answer: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare reference_answer: string | null;

  @Column({ type: DataType.JSON, allowNull: false })
  declare scores: EvaluationScores;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare judge_reason: string | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare input_tokens: number;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare output_tokens: number;

  /** 估算花费（USD） */
  @Column({ type: DataType.DECIMAL(12, 6), allowNull: false, defaultValue: 0 })
  declare cost: number;

  @Column({ type: DataType.INTEGER, allowNull: true })
  declare latency_ms: number | null;

  @CreatedAt
  @Column({ type: DataType.DATE(6) })
  declare created_at: Date;
}
