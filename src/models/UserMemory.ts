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
 * 用户长期记忆 —— B4 长期记忆（docs/12-b-需求-ai对话能力.md §B4）
 *
 * 一行 = 一条「关于这个用户的事实」。
 *
 * ## 为什么另起一张表，而不是塞进 users.preferences
 * `users.preferences`（JSON）能存零散偏好，但它撑不住本功能要的���件事：
 *  - **一条一条地列出来**：用户和租户管理员都要逐条看、逐条改、逐条删
 *  - **来源可追**：这条是自动抽的还是用户自己写的？置信度多少？哪句话抽出来的？
 *  - **生命周期**：自动抽取会改写旧记忆（update / archive），需要软删而不是覆盖
 *  - **注入可控**：每轮只喂 top N 条，不能把整个 JSON 塞进提示词
 *
 * 所以：记忆条目本体在这张表；`users.preferences.memory_enabled` 只存那个开关。
 *
 * ## 记忆的四个分块（category）
 *  - `profile`   画像：用户是谁（岗位、角色、所属团队）
 *  - `preference` 偏好：回答风格、语言、格式偏好
 *  - `fact`      事实：稳定的具体事实（工号、常用产品、所在城市）
 *  - `context`   情境：当前正在处理的事（最容易过时，会被后续抽取改写）
 */

/** 记忆分类 */
export type UserMemoryCategory = 'profile' | 'preference' | 'fact' | 'context';

/** 记忆来源 —— 决定自动抽取能不能改它 */
export type UserMemorySource = 'auto' | 'user' | 'admin';

/** 记忆状态 —— `archived` 是软删，用户和管理员都能看到并恢复 */
export type UserMemoryStatus = 'active' | 'archived';

export const USER_MEMORY_CATEGORIES: readonly UserMemoryCategory[] = [
  'profile',
  'preference',
  'fact',
  'context',
];

export const USER_MEMORY_SOURCES: readonly UserMemorySource[] = ['auto', 'user', 'admin'];

export const USER_MEMORY_STATUSES: readonly UserMemoryStatus[] = ['active', 'archived'];

@Table({ tableName: 'user_memories', timestamps: true })
export class UserMemory extends Model {
  @PrimaryKey
  @Default(() => nanoid(21))
  @Column({ type: DataType.STRING(36) })
  declare id: string;

  @Index({ name: 'idx_user_memories_tenant_user' })
  @Column({ type: DataType.STRING(36), allowNull: false })
  declare tenant_id: string;

  @Column({ type: DataType.STRING(36), allowNull: false })
  declare user_id: string;

  @Column({
    type: DataType.ENUM('profile', 'preference', 'fact', 'context'),
    allowNull: false,
    defaultValue: 'fact',
  })
  declare category: UserMemoryCategory;

  /** 记忆正文（一句话陈述，≤500 字符） */
  @Column({ type: DataType.STRING(500), allowNull: false })
  declare content: string;

  /** 来源：auto=模型自动抽取 / user=用户自己写 / admin=租户管理员写 */
  @Column({
    type: DataType.ENUM('auto', 'user', 'admin'),
    allowNull: false,
    defaultValue: 'auto',
  })
  declare source: UserMemorySource;

  /** 抽取置信度 0~1；用户自己写的恒为 1 */
  @Column({ type: DataType.FLOAT, allowNull: false, defaultValue: 0.5 })
  declare confidence: number;

  @Column({
    type: DataType.ENUM('active', 'archived'),
    allowNull: false,
    defaultValue: 'active',
  })
  declare status: UserMemoryStatus;

  /** 被注入进提示词的次数 */
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare hit_count: number;

  @Column({ type: DataType.DATE(6), allowNull: true })
  declare last_hit_at: Date | null;

  /** 这条记忆是从哪次对话抽出来的（便于回溯当时的原话） */
  @Column({ type: DataType.STRING(36), allowNull: true })
  declare source_session_id: string | null;

  @Column({ type: DataType.STRING(36), allowNull: true })
  declare source_message_id: string | null;

  @CreatedAt
  @Column({ type: DataType.DATE(6) })
  declare created_at: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE(6) })
  declare updated_at: Date;
}
