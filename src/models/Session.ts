import {
  Table,
  Column,
  Model,
  PrimaryKey,
  Default,
  DataType,
  BeforeCreate,
  ForeignKey,
  HasMany,
  Index,
} from 'sequelize-typescript';
import { nanoid } from 'nanoid';
import { Tenant } from './Tenant';
import { Message } from './Message';

/**
 * 会话接入渠道（docs/05-a §对话会话表）
 *  - web     customer 登录后的前台聊天页（B1 落地的那条路径）
 *  - widget  公开挂件（E1，下一轮；user_id 为 NULL 表示匿名访问）
 *  - email / api  预留，本期无入口
 */
export type SessionChannel = 'web' | 'widget' | 'email' | 'api';

export type SessionStatus = 'active' | 'closed' | 'transferred';

/** sessions.metadata JSON 列允许存放的键（运行时不校验，多余键透传） */
export interface SessionMetadata {
  /** 客户端信息（浏览器 / UA 摘要） */
  client?: string;
  /**
   * 用户已批准的敏感工具（B3 HITL）。
   *
   * ⚠️ **这是 B5 状态机的临时形态**：完整的任务状态机（missions 表）还没做，
   *    批准记录先寄在会话的 metadata 里。下一轮做 B5 时迁进 missions。
   *
   * 一条 = 一次批准。键（`key`）的格式是 `工具名:入参指纹`
   * （见 src/tools/execute.ts 的 approvalKey）。
   */
  approved_tool_calls?: SessionToolApproval[];
  [key: string]: unknown;
}

/** 一条敏感工具的批准记录 */
export interface SessionToolApproval {
  /** 批准键 = 工具名 + 入参指纹 */
  key: string;
  /** 工具名 */
  tool_name: string;
  /** 批准时的那份入参（模型下一轮要用同样的参数再调一次） */
  args: unknown;
  approved_at: string;
  /**
   * 状态机：
   *  - `approved` —— 用户点了「确认执行」，等模型再调一次
   *  - `executed` —— 闸门放行，工具真的跑了（不用再提醒模型）
   *  - `rejected` —— 用户点了「取消」，模型不要再调这个
   */
  state: 'approved' | 'executed' | 'rejected';
}

/**
 * 对话会话表（DDL 见 docs/05-a-数据模型-mysql.md §对话会话表）
 *
 * - 一个 session = 一段连续对话；messages 表按 session_id 归属，删会话会级联删消息
 * - `title` 取首条 user 消息的前 20 字自动生成（见 src/services/chat.ts），用户可重命名
 * - `summary` 预留给真摘要压缩（下一轮）：本期只读不写，超长对话靠 token 预算截断
 * - timestamps: false —— DDL 只有 started_at / ended_at，没有 updated_at
 */
@Table({ tableName: 'sessions', timestamps: false })
export class Session extends Model {
  @PrimaryKey
  @Default(() => nanoid(21))
  @Column({ type: DataType.STRING(36) })
  declare id: string;

  @ForeignKey(() => Tenant)
  @Index({ name: 'idx_sessions_tenant_started' })
  @Column({ type: DataType.STRING(36), allowNull: false })
  declare tenant_id: string;

  /** 前台用户 ID；匿名访问（公开挂件）为 NULL */
  @Index({ name: 'idx_sessions_user' })
  @Column({ type: DataType.STRING(36), allowNull: true })
  declare user_id: string | null;

  @Column({ type: DataType.ENUM('web', 'widget', 'email', 'api'), allowNull: false })
  declare channel: SessionChannel;

  @Column({
    type: DataType.ENUM('active', 'closed', 'transferred'),
    allowNull: false,
    defaultValue: 'active',
  })
  declare status: SessionStatus;

  /**
   * 是否收藏（用户标记的重要会话）。
   *
   * 迁移 `031` 加的列。配合「只看收藏」筛选 ——
   * 见 12-e 需求裁定表 #7。
   */
  @Default(false)
  @Column({ type: DataType.BOOLEAN, allowNull: false })
  declare favorite: boolean;

  /** 首条用户消息的前 20 字（自动生成，用户可重命名） */
  @Column({ type: DataType.STRING(200), allowNull: true })
  declare title: string | null;

  /** 摘要压缩后的早期对话内容 —— 真摘要压缩是下一轮，本期恒为 NULL */
  @Column({ type: DataType.TEXT, allowNull: true })
  declare summary: string | null;

  @Column({ type: DataType.JSON })
  declare metadata: SessionMetadata | null;

  @Column({ type: DataType.DATE(6), allowNull: false })
  declare started_at: Date;

  /** 结束时间；NULL = 进行中 */
  @Column({ type: DataType.DATE(6), allowNull: true })
  declare ended_at: Date | null;

  @HasMany(() => Message)
  declare messages?: Message[];

  @BeforeCreate
  static generateId(instance: Session): void {
    if (!instance.id) {
      instance.id = nanoid(21);
    }
  }
}