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
  BelongsTo,
} from 'sequelize-typescript';
import { nanoid } from 'nanoid';
import { Tenant } from './Tenant';
import { User } from './User';

/**
 * API Key 的权限分级 —— docs/10-安全方案.md §10
 *
 *  - read  = 只读。只能调只读端点（知识库检索），**不能发起对话**
 *            （不花钱、不留会话记录）
 *  - write = 写入（默认）。只读 + 发起对话（POST /chat、/chat/stream）
 *  - admin = 管理员。= write 的全部能力 + **管理本租户的知识库**
 *            （文档列表 / 上传 / 删除 —— 见 src/gateway/public/admin-api-routes.ts）
 *
 * 包含关系：write ⊇ read，admin ⊇ write。
 */
export type ApiKeyScope = 'read' | 'write' | 'admin';

/**
 * 租户 API 密钥（docs/05 §5.1）
 * - DB 只存 hash，完整 key 仅创建时返回一次（UI 上"复制"按钮）
 * - key_prefix（前 8 位）用于 UI 识别
 * - 软删除：revoked_at 非空 = 已撤销
 *
 * CRUD 端点在 E1（Step 9+），Step 2 只建表
 */
@Table({ tableName: 'api_keys' })
export class ApiKey extends Model {
  @PrimaryKey
  @Default(() => nanoid(21))
  @Column({ type: DataType.STRING(36) })
  declare id: string;

  @ForeignKey(() => Tenant)
  @Column({ type: DataType.STRING(36), allowNull: false })
  declare tenant_id: string;

  @Column({ type: DataType.STRING(100), allowNull: false })
  declare name: string;

  @Column({ type: DataType.STRING(10), allowNull: false })
  declare key_prefix: string;

  @Column({ type: DataType.STRING(255), allowNull: false })
  declare key_hash: string;

  /**
   * 完整 key 的 sha256（hex，迁移 034）—— **只用于定位，不是凭证**。
   *
   * 凭证判定仍然是 bcrypt（`key_hash`）；这一列是给「按 key 找到那一行」用的：
   * `key_prefix` 只有 8 位且没有单列索引，单独查会全表扫；
   * sha256 有唯一索引 → 精确命中，O(log n)。
   *
   * 存量 key 没有这一列的值（NULL），第一次鉴权成功时会自动回填（自愈）。
   */
  @Column({ type: DataType.STRING(64), allowNull: true })
  declare key_sha256: string | null;

  /**
   * 权限分级（migration 020）——
   * 默认 write：加列之前的所有 key 都是这个行为，不改。
   */
  @Column({ type: DataType.ENUM('read', 'write', 'admin'), allowNull: false, defaultValue: 'write' })
  declare scope: ApiKeyScope;

  @Column({ type: DataType.DATE(6) })
  declare last_used_at: Date | null;

  @Column({ type: DataType.DATE(6) })
  declare expires_at: Date | null;

  @Column({ type: DataType.DATE(6) })
  declare revoked_at: Date | null;

  @ForeignKey(() => User)
  @Column({ type: DataType.STRING(36), allowNull: false })
  declare created_by: string;

  @CreatedAt
  @Column({ type: DataType.DATE(6) })
  declare created_at: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE(6) })
  declare updated_at: Date;

  @BelongsTo(() => Tenant)
  declare tenant?: Tenant;

  @BelongsTo(() => User)
  declare creator?: User;

  @BeforeCreate
  static generateId(instance: ApiKey): void {
    if (!instance.id) {
      instance.id = nanoid(21);
    }
  }
}
