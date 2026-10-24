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
 * 评测跑批 —— D1 评测
 *
 * 一行 = 「用某个提示词版本 + 某个模型，把某个评测集跑一遍」的结果。
 *
 * 四个维度的分数都是 **0~5 的平均分**（不是 0~1 的比例）：
 * 裁判按「完全对 / 基本对 / 答了但有偏差 / 没答到 / 答错」五档打分，
 * 取平均后仍然是 0~5，页面按 5 分制展示。
 *
 * `total_score` 是四维的平均 —— **趋势对比看这个**（单看某一维容易被刷）。
 */
@Table({ tableName: 'evaluation_runs', timestamps: false })
export class EvaluationRun extends Model {
  @PrimaryKey
  @Default(() => nanoid(21))
  @Column({ type: DataType.STRING(36) })
  declare id: string;

  @Index({ name: 'idx_eval_runs_tenant_created' })
  @Column({ type: DataType.STRING(36), allowNull: false })
  declare tenant_id: string;

  @Index({ name: 'idx_eval_runs_dataset_created' })
  @Column({ type: DataType.STRING(36), allowNull: false })
  declare dataset_id: string;

  /** 评测集名称快照（评测集改名 / 删除后还能看） */
  @Column({ type: DataType.STRING(100), allowNull: true })
  declare dataset_name: string | null;

  /** 这次跑批用的提示词版本（null = 内置默认提示词） */
  @Column({ type: DataType.STRING(64), allowNull: true })
  declare prompt_version: string | null;

  @Column({ type: DataType.STRING(100), allowNull: true })
  declare model: string | null;

  @Column({ type: DataType.STRING(32), allowNull: true })
  declare provider: string | null;

  /** running / completed / failed */
  @Column({ type: DataType.STRING(16), allowNull: false, defaultValue: 'running' })
  declare status: string;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare total_items: number;

  /** 已完成条数（跑批过程中显示进度） */
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare completed_items: number;

  @Column({ type: DataType.FLOAT, allowNull: true })
  declare accuracy: number | null;

  @Column({ type: DataType.FLOAT, allowNull: true })
  declare completeness: number | null;

  @Column({ type: DataType.FLOAT, allowNull: true })
  declare style: number | null;

  @Column({ type: DataType.FLOAT, allowNull: true })
  declare safety: number | null;

  /** 四维平均（0~5）—— 趋势对比看这个 */
  @Column({ type: DataType.FLOAT, allowNull: true })
  declare total_score: number | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare total_tokens: number;

  /** 估算花费（USD） */
  @Column({ type: DataType.DECIMAL(12, 6), allowNull: false, defaultValue: 0 })
  declare total_cost: number;

  @Column({ type: DataType.STRING(500), allowNull: true })
  declare error_message: string | null;

  @Column({ type: DataType.DATE(6), allowNull: false })
  declare started_at: Date;

  @Column({ type: DataType.DATE(6), allowNull: true })
  declare finished_at: Date | null;

  @CreatedAt
  @Column({ type: DataType.DATE(6) })
  declare created_at: Date;
}
