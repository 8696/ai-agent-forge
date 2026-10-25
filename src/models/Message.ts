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
  BelongsTo,
  Index,
} from 'sequelize-typescript';
import { nanoid } from 'nanoid';
import { Tenant } from './Tenant';
import { Session } from './Session';

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

/**
 * 消息状态机
 *   user    消息直接落 complete
 *   assistant  streaming（流开始时先建行）→ complete / failed / cancelled
 *
 * `failed` 保留已经生成出来的部分正文：用户断开或 provider 报错时，
 * 半截回答也比完全没有回答有用（且要能看出这次是失败的）。
 */
export type MessageStatus = 'streaming' | 'complete' | 'failed' | 'cancelled';

/** messages.usage JSON 列 —— 取自 LLM 返回的 usage，不是本地估算值 */
export interface MessageUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  [key: string]: unknown;
}

/**
 * messages.parts JSON 列 —— AI SDK 的 data part 数组（落库用）
 *
 * 装的是消息上所有 `data-*` part：引用片段（data-citations）、
 * 工具调用记录（data-tool-call）等。刷新页面后靠这一列还原 UI。
 *
 * ⚠️ **这一列是 2026-10-25 从 `tool_results` 里挪出来的** ——
 * 以前 data part 借用了 `tool_results`（DDL 原意是「工具调用的输出」），
 * 两种语义混在一列里，前端只能靠 key 猜。迁移 `023-messages-parts-column`
 * 把 data part 搬到了这里，`tool_results` 语义还给真正的工具输出。
 */
export interface MessageParts {
  data_parts: DataPartShape[];
  [key: string]: unknown;
}

/**
 * messages.tool_results JSON 列 —— 真正的工具调用输出
 *
 * DDL 原意就是「工具调用的输出」（B3 工具调用，2026-10-25 落地）。
 * ⚠️ 这一列**不再装 data part** —— data part 在 `parts` 列里。
 *
 * 读写统一走 src/services/chat.ts，别在别处直接碰这一列。
 */
export interface MessageToolResults {
  /** 工具调用名 */
  tool?: string;
  /** 工具的返回值 */
  output?: unknown;
  [key: string]: unknown;
}

/** 落库时的 data part 最小形状（只存类型 + 数据，不存 state 等 UI 态） */
export interface DataPartShape {
  type: string;
  data: unknown;
}

/**
 * 聊天消息表（DDL 见 docs/05-a-数据模型-mysql.md §消息表）
 *
 * - DB 是对话历史的真理来源：会话历史、上下文重建、评测回放都从这里读
 * - `usage` 存 LLM 返回的真实 token 数；本地的 estimateTokens() 只用于预算截断，不用于计费
 * - `parts` 存 AI SDK 的 data part 数组（引用片段 / 工具调用记录）；`tool_results` 存工具输出
 * - timestamps: false —— DDL 只有 created_at
 */
@Table({ tableName: 'messages', timestamps: false })
export class Message extends Model {
  @PrimaryKey
  @Default(() => nanoid(21))
  @Column({ type: DataType.STRING(36) })
  declare id: string;

  @ForeignKey(() => Session)
  @Index({ name: 'idx_messages_session_created' })
  @Column({ type: DataType.STRING(36), allowNull: false })
  declare session_id: string;

  /** 冗余存：按租户统计 / 成本汇总时不用 join sessions */
  @ForeignKey(() => Tenant)
  @Index({ name: 'idx_messages_tenant_created' })
  @Column({ type: DataType.STRING(36), allowNull: false })
  declare tenant_id: string;

  @Column({
    type: DataType.ENUM('user', 'assistant', 'system', 'tool'),
    allowNull: false,
  })
  declare role: MessageRole;

  /** 消息正文（Markdown / 纯文本） */
  @Column({ type: DataType.TEXT('medium'), allowNull: true })
  declare content: string | null;

  /** 思考模式的推理过程，与正文分离存储 */
  @Column({ type: DataType.TEXT('medium'), allowNull: true })
  declare thinking_content: string | null;

  /** 工具调用的输入 —— B3 工具调用后有值 */
  @Column({ type: DataType.JSON, allowNull: true })
  declare tool_calls: unknown;

  /**
   * 工具调用的输出（B3 工具调用）
   */
  @Column({ type: DataType.JSON, allowNull: true })
  declare tool_results: MessageToolResults | null;

  /**
   * AI SDK 的 data part 数组（引用片段 / 工具调用记录）。
   * 2026-10-25 从 `tool_results` 挪出来的独立列（迁移 `023-messages-parts-column`）。
   */
  @Column({ type: DataType.JSON, allowNull: true })
  declare parts: MessageParts | null;

  @Column({ type: DataType.JSON, allowNull: true })
  declare usage: MessageUsage | null;

  @Column({
    type: DataType.ENUM('streaming', 'complete', 'failed', 'cancelled'),
    allowNull: false,
    defaultValue: 'complete',
  })
  declare status: MessageStatus;

  /** 用户反馈：1 = 点赞 / -1 = 点踩 / NULL = 无 */
  @Column({ type: DataType.TINYINT, allowNull: true })
  declare feedback: number | null;

  @Column({ type: DataType.STRING(1000), allowNull: true })
  declare feedback_text: string | null;

  @Column({ type: DataType.DATE(6), allowNull: true })
  declare feedback_at: Date | null;

  /** 关联 traces 表（D2 观测）；本期 trace 还没建，先留空 */
  @Index({ name: 'idx_messages_trace' })
  @Column({ type: DataType.STRING(36), allowNull: true })
  declare trace_id: string | null;

  @CreatedAt
  @Column({ type: DataType.DATE(6) })
  declare created_at: Date;

  @BelongsTo(() => Session)
  declare session?: Session;

  @BeforeCreate
  static generateId(instance: Message): void {
    if (!instance.id) {
      instance.id = nanoid(21);
    }
  }
}