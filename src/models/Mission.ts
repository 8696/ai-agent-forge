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
import { DataTypes } from 'sequelize';
import { nanoid } from 'nanoid';
import { Tenant } from './Tenant';

/**
 * 任务表 —— B5 状态机工作流（docs/12-b-需求-ai对话能力.md §B5 / §B5.1）
 *
 * 一行 = 一次业务流程任务（退款 / 改地址 / 建售后工单）。
 *
 * ## 状态机
 *
 * ```
 *   (无) → pending ──→ awaiting_confirmation ──用户确认──→ running ──→ completed
 *              │              │                              │
 *              └──→ running   └──用户拒绝 / 超时──→ cancelled   └──节点报错──→ failed
 * ```
 *
 * ## 跟 `sessions.metadata.approved_tool_calls` 的分工
 *
 * 这两个**不是一回事**，别混：
 *
 *  - **`approved_tool_calls`** = **授权令牌**。用户点了一次「确认执行」，
 *    30 分钟内有效，绑定了「工具名 + 那次调用的入参」。闸门靠它决定放不放行。
 *  - **`missions`** = **流程账本**。记的是「这件事走到哪一步了、收集到了什么」。
 *
 * 一个令牌可以对应一次流程推进；一条流程会经过多个令牌。
 * 两者生命周期不同（令牌 30 分钟过期，流程按节点推进），所以分开放。
 */
export type MissionState =
  | 'pending'
  | 'running'
  | 'awaiting_confirmation'
  | 'completed'
  | 'failed'
  | 'cancelled';

export const MISSION_STATES: readonly MissionState[] = [
  'pending',
  'running',
  'awaiting_confirmation',
  'completed',
  'failed',
  'cancelled',
];

/**
 * `missions.context` JSON 列的形状。
 *
 * 只存**流程收集到的中间数据**（订单信息、优惠信息…），不存会话上下文
 * （那是 `sessions.metadata` 的活）。
 */
export interface MissionContext {
  /** 已完成的节点 id */
  steps?: string[];
  /** 每个节点的结果，key = 节点 id */
  outputs?: Record<string, unknown>;
  /** 用户确认的那次调用的入参（模型改参数时回传给它） */
  approved_args?: unknown;
  [key: string]: unknown;
}

@Table({ tableName: 'missions' })
export class Mission extends Model {
  @PrimaryKey
  @Default(() => nanoid(21))
  @Column({ type: DataTypes.STRING(36) })
  declare id: string;

  @ForeignKey(() => Tenant)
  @Index({ name: 'idx_missions_tenant_state' })
  @Column({ type: DataTypes.STRING(36), allowNull: false })
  declare tenant_id: string;

  /** 触发的会话；后台任务为 null */
  @Index({ name: 'idx_missions_session' })
  @Column({ type: DataTypes.STRING(36), allowNull: true })
  declare session_id: string | null;

  /** 触发者；匿名挂件 / 对外 API 为 null */
  @Column({ type: DataTypes.STRING(36), allowNull: true })
  declare user_id: string | null;

  /** 流程类型 —— 对应 `src/workflows/definitions.ts` 的流程定义 */
  @Column({ type: DataTypes.STRING(100), allowNull: false })
  declare type: string;

  @Default('pending')
  @Column({
    type: DataTypes.ENUM(
      'pending',
      'running',
      'awaiting_confirmation',
      'completed',
      'failed',
      'cancelled',
    ),
    allowNull: false,
    defaultValue: 'pending',
  })
  declare state: MissionState;

  /** 是否含敏感操作（true 时流程会停在等用户确认） */
  @Default(false)
  @Column({ type: DataTypes.BOOLEAN, allowNull: false })
  declare is_sensitive: boolean;

  /** 当前节点 id —— 断点恢复靠它知道从哪继续 */
  @Column({ type: DataTypes.STRING(100), allowNull: true })
  declare current_step: string | null;

  /** 用户批准的那次工具调用（`工具名:入参指纹`，见 `approvalKey()`） */
  @Column({ type: DataTypes.STRING(255), allowNull: true })
  declare approval_key: string | null;

  /** 流程收集到的中间数据 */
  @Column({ type: DataTypes.JSON, allowNull: true })
  declare context: MissionContext | null;

  /** 流程最终结果 */
  @Column({ type: DataTypes.JSON, allowNull: true })
  declare result: unknown;

  /** 超时时间 —— 过期后转 `cancelled` */
  @Column({ type: DataTypes.DATE(6), allowNull: true })
  declare expires_at: Date | null;

  @CreatedAt
  @Column({ type: DataTypes.DATE(6) })
  declare created_at: Date;

  @UpdatedAt
  @Column({ type: DataTypes.DATE(6) })
  declare updated_at: Date;

  @BeforeCreate
  static generateId(instance: Mission): void {
    if (!instance.id) {
      instance.id = nanoid(21);
    }
  }
}
