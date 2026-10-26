import {
  Table,
  Column,
  Model,
  PrimaryKey,
  Default,
  DataType,
  CreatedAt,
  BeforeCreate,
  ForeignKey,
  Index,
} from 'sequelize-typescript';
import { nanoid } from 'nanoid';
import { Tenant } from './Tenant';

/**
 * 多代理的每一步 —— B6 多代理协作
 *
 * 一行 = **一次子代理调用**。
 *
 * ## `span_id` 是干什么的
 *
 * B6 验收：「每个子代理的调用在 trace 里**各自独立成 span**，
 * 在 trace 详情页能看出**调用树**」。
 *
 * 子代理的 span 是**主 agent 的 `llm.generate` span 的子 span**
 * （`spans.parent_span_id`）—— 这就是调用树。
 * 这里的 `span_id` 只是把这一步跟那个 span 对上（方便从这一步回查 trace）。
 */
export type AgentStepState = 'ok' | 'failed';

export const AGENT_STEP_STATES: readonly AgentStepState[] = ['ok', 'failed'];

/**
 * ⚠️ `timestamps: false` —— 这张表**只有 `created_at`**（步骤是不可变记录，
 *    没有「改过」这回事）。
 *    不关掉的话 Sequelize 会自动加一个 `updatedAt` 属性，
 *    往一个**不存在的列**里写 → `Unknown column 'updatedAt'`。
 *    跟 `tool_call_logs` 同一个处理。
 */
@Table({ tableName: 'agent_steps', timestamps: false })
export class AgentStep extends Model {
  @PrimaryKey
  @Default(() => nanoid(21))
  @Column({ type: DataType.STRING(36) })
  declare id: string;

  @ForeignKey(() => Tenant)
  @Index({ name: 'idx_agent_steps_tenant' })
  @Column({ type: DataType.STRING(36), allowNull: false })
  declare tenant_id: string;

  /** 所属批次 */
  @Index({ name: 'idx_agent_steps_run' })
  @Column({ type: DataType.STRING(36), allowNull: false })
  declare run_id: string;

  /** 子代理角色 key */
  @Column({ type: DataType.STRING(64), allowNull: false })
  declare agent: string;

  /** 子任务描述 */
  @Column({ type: DataType.TEXT, allowNull: false })
  declare task: string;

  /** 子代理产出 */
  @Column({ type: DataType.JSON, allowNull: true })
  declare output: unknown;

  @Default('ok')
  @Column({
    type: DataType.ENUM('ok', 'failed'),
    allowNull: false,
    defaultValue: 'ok',
  })
  declare state: AgentStepState;

  /** 失败原因 */
  @Column({ type: DataType.STRING(1000), allowNull: true })
  declare error: string | null;

  /** 关联的 trace span（调用树靠它） */
  @Column({ type: DataType.STRING(36), allowNull: true })
  declare span_id: string | null;

  @CreatedAt
  @Column({ type: DataType.DATE(6) })
  declare created_at: Date;

  @BeforeCreate
  static generateId(instance: AgentStep): void {
    if (!instance.id) {
      instance.id = nanoid(21);
    }
  }
}
