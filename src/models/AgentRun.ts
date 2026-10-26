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
 * 多代理批次 —— B6 多代理协作（docs/12-b-需求-ai对话能力.md §B6）
 *
 * 一行 = **一轮对话里主 agent 派活的那一摊**。
 *
 * ## 共享状态（shared_state）
 *
 * B6 验收要求「子代理之间通过共享状态协作，**不靠主代理复述上下文**」。
 * 实现：`{ agent_key: 产出 }`，下一个子代理跑的时候**引擎直接注入**它的提示词 ——
 * 不是主 agent 转述一遍。
 */
export type AgentRunState = 'running' | 'completed' | 'failed';

export const AGENT_RUN_STATES: readonly AgentRunState[] = ['running', 'completed', 'failed'];

@Table({ tableName: 'agent_runs' })
export class AgentRun extends Model {
  @PrimaryKey
  @Default(() => nanoid(21))
  @Column({ type: DataType.STRING(36) })
  declare id: string;

  @ForeignKey(() => Tenant)
  @Index({ name: 'idx_agent_runs_tenant_state' })
  @Column({ type: DataType.STRING(36), allowNull: false })
  declare tenant_id: string;

  /** 触发的会话 */
  @Index({ name: 'idx_agent_runs_session' })
  @Column({ type: DataType.STRING(36), allowNull: true })
  declare session_id: string | null;

  /** 触发者（匿名挂件 / 对外 API 为空） */
  @Column({ type: DataType.STRING(36), allowNull: true })
  declare user_id: string | null;

  /**
   * 触发这轮对话的 assistant 消息 id —— 用来定位「本轮」的批次。
   *
   * 一轮对话里主 agent 可能派好几次活，它们属于**同一个批次**（共享状态互通）；
   * 下一轮对话就是新批次。
   */
  @Index({ name: 'idx_agent_runs_tenant_turn' })
  @Column({ type: DataType.STRING(36), allowNull: true })
  declare turn_id: string | null;

  /** 触发这次多代理的原始问题 */
  @Column({ type: DataType.TEXT, allowNull: false })
  declare question: string;

  @Default('running')
  @Column({
    type: DataType.ENUM('running', 'completed', 'failed'),
    allowNull: false,
    defaultValue: 'running',
  })
  declare state: AgentRunState;

  /** 共享状态：`{ agent_key: 产出 }` */
  @Column({ type: DataType.JSON, allowNull: true })
  declare shared_state: Record<string, unknown> | null;

  /** 最终结果 */
  @Column({ type: DataType.JSON, allowNull: true })
  declare result: unknown;

  @CreatedAt
  @Column({ type: DataType.DATE(6) })
  declare created_at: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE(6) })
  declare updated_at: Date;

  @BeforeCreate
  static generateId(instance: AgentRun): void {
    if (!instance.id) {
      instance.id = nanoid(21);
    }
  }
}
