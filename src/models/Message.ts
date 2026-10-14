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
} from 'sequelize-typescript';
import { nanoid } from 'nanoid';
import { Session } from './Session';

/**
 * 消息角色（与 docs/05-a §5.1 messages.role 一致）
 *  - user       用户消息
 *  - assistant  模型回复
 *  - system     系统提示词或注入上下文（不会直接来自前端）
 *  - tool       工具调用结果（Vercel AI SDK tool messages）
 */
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

/**
 * 消息状态（流式用；与 docs/05-a §5.1 messages.status 一致）
 *  - streaming  流式生成中
 *  - complete   完成
 *  - failed     出错
 *  - cancelled  用户中止
 */
export type MessageStatus = 'streaming' | 'complete' | 'failed' | 'cancelled';

/**
 * Anthropic API 返回的 token 用量（存 messages.usage JSON 列）
 *  - promptTokens    input tokens（含 cache 写）
 *  - completionTokens output tokens
 *  - cacheReadTokens 从 prompt cache 读到的 tokens（命中部分）
 */
export interface MessageUsage {
  promptTokens?: number;
  completionTokens?: number;
  cacheReadTokens?: number;
  totalTokens?: number;
}

/**
 * 工具调用 / 结果（Vercel AI SDK tool calls 序列化形式）
 */
export interface MessageToolCall {
  toolCallId: string;
  toolName: string;
  args: unknown;
}
export interface MessageToolResult {
  toolCallId: string;
  toolName: string;
  result: unknown;
}

/**
 * 消息表（DDL 见 docs/05-a §5.1 + 迁移 src/migrations/009-create-messages.ts）
 *  - content           正文（Markdown / 纯文本）
 *  - thinking_content  思考模式推理过程（与 content 分离；Step 8 前端折叠展示）
 *  - tool_calls        工具调用输入
 *  - tool_results      工具调用输出
 *  - usage             token 用量
 *  - status            流式状态（'streaming' → 'complete'/'failed'/'cancelled'）
 *  - feedback          用户反馈（1/-1/NULL）
 *  - trace_id          关联到 Step 11 traces（先建字段，Step 11 落地时回填）
 *  - 没有 updated_at 列（D5 spec 不要求）；用 `timestamps: false` 关掉 Sequelize 默认 updatedAt
 */
@Table({ tableName: 'messages', timestamps: false })
export class Message extends Model {
  @PrimaryKey
  @Default(() => nanoid(21))
  @Column({ type: DataType.STRING(36) })
  declare id: string;

  @ForeignKey(() => Session)
  @Column({ type: DataType.STRING(36), allowNull: false })
  declare session_id: string;

  @Column({ type: DataType.STRING(36), allowNull: false })
  declare tenant_id: string;

  @Column({
    type: DataType.ENUM('user', 'assistant', 'system', 'tool'),
    allowNull: false,
  })
  declare role: MessageRole;

  @Column({ type: DataType.TEXT('medium'), allowNull: true })
  declare content: string | null;

  @Column({ type: DataType.TEXT('medium'), allowNull: true })
  declare thinking_content: string | null;

  @Column({ type: DataType.JSON, allowNull: true })
  declare tool_calls: MessageToolCall[] | null;

  @Column({ type: DataType.JSON, allowNull: true })
  declare tool_results: MessageToolResult[] | null;

  @Column({ type: DataType.JSON, allowNull: true })
  declare usage: MessageUsage | null;

  @Default('complete')
  @Column({
    type: DataType.ENUM('streaming', 'complete', 'failed', 'cancelled'),
  })
  declare status: MessageStatus;

  @Column({ type: DataType.TINYINT, allowNull: true })
  declare feedback: number | null;

  @Column({ type: DataType.STRING(1000), allowNull: true })
  declare feedback_text: string | null;

  @Column({ type: DataType.DATE(6), allowNull: true })
  declare feedback_at: Date | null;

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
