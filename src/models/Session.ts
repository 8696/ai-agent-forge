import {
  Table,
  Column,
  Model,
  PrimaryKey,
  Default,
  DataType,
  ForeignKey,
  BelongsTo,
  BeforeCreate,
} from 'sequelize-typescript';
import { nanoid } from 'nanoid';
import { Tenant } from './Tenant';
import { User } from './User';

/**
 * 会话接入渠道（与 docs/05-a §5.1 sessions.channel 一致）
 *  - widget  公开聊天挂件
 *  - email   邮件接入（Phase 2）
 *  - api     外部 API（E1 api_keys 调用 /api/v1/chat）
 */
export type SessionChannel = 'widget' | 'email' | 'api';

/**
 * 会话状态（与 docs/05-a §5.1 sessions.status 一致）
 *  - active      进行中（默认）
 *  - closed      正常结束
 *  - transferred 转人工（Phase 2 坐席上线后才有意义）
 */
export type SessionStatus = 'active' | 'closed' | 'transferred';

/**
 * metadata JSON 列允许存放的键（多余键透传保留 forward-compat）
 */
export interface SessionMetadata {
  source?: string; // 挂件 / API 调用的来源标识
  userAgent?: string;
  referrer?: string;
  ip?: string;
  [key: string]: unknown;
}

/**
 * 对话会话表（DDL 见 docs/05-a §5.1 + 迁移 src/migrations/008-create-sessions.ts）
 *  - 一次完整对话 = 一个 session
 *  - 第一条 user message 入库时自动回填 `title`（前 20 字）
 *  - 上下文窗口超长时自动回填 `summary`（Step 7 main loop 维护）
 *  - 没有 updated_at 列（D5 spec 不要求）；用 `timestamps: false` 关掉 Sequelize 默认 updatedAt
 */
@Table({ tableName: 'sessions', timestamps: false })
export class Session extends Model {
  @PrimaryKey
  @Default(() => nanoid(21))
  @Column({ type: DataType.STRING(36) })
  declare id: string;

  @ForeignKey(() => Tenant)
  @Column({ type: DataType.STRING(36), allowNull: false })
  declare tenant_id: string;

  @ForeignKey(() => User)
  @Column({ type: DataType.STRING(36), allowNull: true })
  declare user_id: string | null;

  @Column({
    type: DataType.ENUM('widget', 'email', 'api'),
    allowNull: false,
  })
  declare channel: SessionChannel;

  @Default('active')
  @Column({
    type: DataType.ENUM('active', 'closed', 'transferred'),
  })
  declare status: SessionStatus;

  @Column({ type: DataType.STRING(200), allowNull: true })
  declare title: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare summary: string | null;

  @Column({ type: DataType.JSON, allowNull: true })
  declare metadata: SessionMetadata | null;

  @Column({
    type: DataType.DATE(6),
    allowNull: false,
    defaultValue: DataType.NOW,
  })
  declare started_at: Date;

  @Column({ type: DataType.DATE(6), allowNull: true })
  declare ended_at: Date | null;

  @BelongsTo(() => Tenant)
  declare tenant?: Tenant;

  @BelongsTo(() => User)
  declare user?: User;

  @BeforeCreate
  static generateId(instance: Session): void {
    if (!instance.id) {
      instance.id = nanoid(21);
    }
  }
}
