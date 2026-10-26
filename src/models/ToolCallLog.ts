import { Table, Column, Model, PrimaryKey, Default, DataType, CreatedAt, Index } from 'sequelize-typescript';
import { nanoid } from 'nanoid';

/**
 * 工具调用流水 —— B3 工具调用（docs/12-b-需求-ai对话能力.md §B3）
 *
 * 一行 = **一次工具调用**。回答三个问题：
 *   - 「AI 到底调没调这个工具」（调没调、什么时候调的）
 *   - 「它拿什么参数调的、返回了什么」（请求参数 / 响应参数）
 *   - 「哪些工具在失败」（错误率、错误信息）
 *
 * ## 为什么单独一张表，不去查 messages.parts
 *
 * 工具调用记录本来就落在 `messages.parts` 的 `data-tool-call` part 里（含参数和结果），
 * 但那是 **JSON 列**，没法按时间 / 工具 / 状态建索引 —— 分页翻页都得全表扫，
 * 「只看失败的」「只看某个工具的」更做不了。要一个能筛的列表就得有正经的列。
 *
 * ## 状态
 *
 *  - `ok` —— 调用成功
 *  - `error` —— 工具自己抛错（已经降级成 tool result 回灌，整轮没挂）
 *  - `timeout` —— 超过 5 秒被放弃
 *  - `awaiting_confirmation` —— 敏感工具被 HITL 闸门拦下，**没有真正执行**
 *  - `rejected` —— 用户点了「取消」，模型没再调（闸门直接回「用户拒绝」）
 *  - `blocked` —— **前置步骤没满足**（B5 工作流闸门）：模型想直接提交退款，
 *    但还没查过订单 → 闸门拦住并告诉模型「先查订单」。不是错误，是流程约束
 *
 * @Table timestamps: false —— DDL 只有 created_at
 */
export type ToolCallStatus =
  | 'ok'
  | 'error'
  | 'timeout'
  | 'awaiting_confirmation'
  | 'rejected'
  | 'blocked';

@Table({ tableName: 'tool_call_logs', timestamps: false })
export class ToolCallLog extends Model {
  @PrimaryKey
  @Default(() => nanoid(21))
  @Column({ type: DataType.STRING(36) })
  declare id: string;

  /** 所属租户 */
  @Index({ name: 'idx_tool_call_logs_tenant_created' })
  @Column({ type: DataType.STRING(36), allowNull: false })
  declare tenant_id: string;

  /** 触发调用的用户（匿名挂件 / 对外 API 为 null） */
  @Column({ type: DataType.STRING(36), allowNull: true })
  declare user_id: string | null;

  /** 所属会话 */
  @Index({ name: 'idx_tool_call_logs_session' })
  @Column({ type: DataType.STRING(36), allowNull: true })
  declare session_id: string | null;

  /** 关联的 assistant 消息 id */
  @Column({ type: DataType.STRING(36), allowNull: true })
  declare message_id: string | null;

  /** SDK 分配的调用 id（同一个工具被调多次时靠它区分） */
  @Column({ type: DataType.STRING(64), allowNull: false })
  declare tool_call_id: string;

  /** 注册名（模型调用的就是这个名字） */
  @Column({ type: DataType.STRING(100), allowNull: false })
  declare tool_name: string;

  /** 内置实现 key */
  @Column({ type: DataType.STRING(64), allowNull: true })
  declare builtin: string | null;

  @Column({
    type: DataType.ENUM('ok', 'error', 'timeout', 'awaiting_confirmation', 'rejected', 'blocked'),
    allowNull: false,
    defaultValue: 'ok',
  })
  declare status: ToolCallStatus;

  /** 请求参数（模型给的入参） */
  @Column({ type: DataType.JSON, allowNull: true })
  declare args: unknown;

  /** 响应参数（工具的返回值） */
  @Column({ type: DataType.JSON, allowNull: true })
  declare output: unknown;

  /** 失败原因（成功时为 null） */
  @Column({ type: DataType.STRING(1000), allowNull: true })
  declare error: string | null;

  /** 耗时（毫秒） */
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare duration_ms: number;

  /** 关联的 trace（去 trace 详情页看那一轮的全过程） */
  @Column({ type: DataType.STRING(36), allowNull: true })
  declare trace_id: string | null;

  @CreatedAt
  @Column({ type: DataType.DATE(6) })
  declare created_at: Date;
}
