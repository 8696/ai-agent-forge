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
 * 提示词版本状态
 *
 * 一个租户**同时最多只有一个 production** —— 发布（publish）时会把该租户其他版本
 * 置为 archived，这个不变式由 src/services/prompt-registry.ts 保证（单事务内改）。
 * draft 可以随便改（后台编辑器保存草稿）；archived 是历史，只读。
 */
export type PromptVersionStatus = 'draft' | 'production' | 'archived';

/**
 * 租户提示词版本表（DDL 见 docs/05-a-数据模型-mysql.md §提示词版本表）
 *
 * - 每个租户自己一套提示词（docs/12-c §C3），多版本并存，可发布可回滚
 * - `content` 存正文，支持 `{{tenantName}}` 占位符（渲染见 shared/prompts/chat/system-default.ts）
 * - 没有版本时回落 `shared/prompts/chat/system-default.ts` 里的内置默认提示词，
 *   所以这张表为空不影响对话功能
 */
@Table({ tableName: 'prompt_versions' })
export class PromptVersion extends Model {
  @PrimaryKey
  @Default(() => nanoid(21))
  @Column({ type: DataType.STRING(36) })
  declare id: string;

  @ForeignKey(() => Tenant)
  @Column({ type: DataType.STRING(36), allowNull: false })
  declare tenant_id: string;

  /** 版本号（v1 / v2 …），租户内唯一 */
  @Column({ type: DataType.STRING(20), allowNull: false })
  declare version: string;

  @Column({
    type: DataType.ENUM('draft', 'production', 'archived'),
    allowNull: false,
    defaultValue: 'draft',
  })
  declare status: PromptVersionStatus;

  /** 提示词正文（支持 {{tenantName}} 占位符） */
  @Column({ type: DataType.TEXT('medium'), allowNull: false })
  declare content: string;

  /** 这个版本改了什么 —— 发布时给一句说明，便于回溯 */
  @Column({ type: DataType.STRING(200), allowNull: true })
  declare description: string | null;

  @Column({ type: DataType.DATE(6), allowNull: true })
  declare deployed_at: Date | null;

  /** 发布人 user_id */
  @Column({ type: DataType.STRING(36), allowNull: true })
  declare deployed_by: string | null;

  @Column({ type: DataType.STRING(36), allowNull: false })
  declare created_by: string;

  @CreatedAt
  @Column({ type: DataType.DATE(6) })
  declare created_at: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE(6) })
  declare updated_at: Date;

  @BeforeCreate
  static generateId(instance: PromptVersion): void {
    if (!instance.id) {
      instance.id = nanoid(21);
    }
  }
}