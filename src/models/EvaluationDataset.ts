import {
  Table,
  Column,
  Model,
  PrimaryKey,
  Default,
  DataType,
  CreatedAt,
  UpdatedAt,
  Index,
} from 'sequelize-typescript';
import { nanoid } from 'nanoid';

/**
 * 评测集 —— D1 评测（docs/12-d-需求-运维稳定.md §D1）
 *
 * 一次上传的题目集合。同一个 name 可以有多版（version 区分），
 * 这样「改提示词后重跑同一套题」才有可比性。
 */
@Table({ tableName: 'evaluation_datasets', timestamps: true })
export class EvaluationDataset extends Model {
  @PrimaryKey
  @Default(() => nanoid(21))
  @Column({ type: DataType.STRING(36) })
  declare id: string;

  @Index({ name: 'idx_eval_datasets_tenant_created' })
  @Column({ type: DataType.STRING(36), allowNull: false })
  declare tenant_id: string;

  @Column({ type: DataType.STRING(100), allowNull: false })
  declare name: string;

  @Column({ type: DataType.STRING(32), allowNull: false, defaultValue: 'v1' })
  declare version: string;

  @Column({ type: DataType.STRING(500), allowNull: true })
  declare description: string | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare item_count: number;

  @Column({ type: DataType.STRING(36), allowNull: true })
  declare created_by: string | null;

  @CreatedAt
  @Column({ type: DataType.DATE(6) })
  declare created_at: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE(6) })
  declare updated_at: Date;
}
