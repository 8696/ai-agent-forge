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
 * 文档索引状态机（docs/05-a §知识库文档表）
 *
 *   uploaded → indexing → ready
 *              ↘         ↘
 *                failed    failed
 *
 * 当前实现是**同步索引**：上传请求里直接跑完「解析 → 拆块 → Embedding → 入 Qdrant」，
 * 所以正常路径只观察到 indexing → ready / failed；uploaded 是「先建行再处理」时的初值，
 * 进程在两者之间挂掉时靠这个状态区分「文件还没开始处理」和「处理到一半失败」。
 */
export type DocumentStatus = 'uploaded' | 'indexing' | 'ready' | 'failed';

export type DocumentFileType = 'pdf' | 'markdown' | 'txt';

/** documents.metadata JSON 列允许存放的键（运行时不校验，多余键透传） */
export interface DocumentMetadata {
  /** 页数（PDF） */
  pages?: number;
  /** 原始字节数 */
  bytes?: number;
  /** 业务标签 / 部门等 */
  [key: string]: unknown;
}

/**
 * 知识库文档元数据表（DDL 见 docs/05-a-数据模型-mysql.md）
 *
 * - 向量本身在 Qdrant `documents` collection，本表的 `id` 对应 payload.doc_id
 * - `chunk_count` 与 Qdrant 里该 doc_id 的点数对齐，索引成功 / 失败时由路由层回填
 */
@Table({ tableName: 'documents' })
export class Document extends Model {
  @PrimaryKey
  @Default(() => nanoid(21))
  @Column({ type: DataType.STRING(36) })
  declare id: string;

  @ForeignKey(() => Tenant)
  @Index({ name: 'idx_documents_tenant_uploaded' })
  @Column({ type: DataType.STRING(36), allowNull: false })
  declare tenant_id: string;

  /** 原始文件名（= 标题，UI 显示用） */
  @Column({ type: DataType.STRING(500), allowNull: false })
  declare title: string;

  @Column({
    type: DataType.ENUM('pdf', 'markdown', 'txt'),
    allowNull: true,
  })
  declare file_type: DocumentFileType | null;

  /** 磁盘存储文件名（相对 DATA_DIR/uploads/{tenant_id}/） */
  @Column({ type: DataType.STRING(500), allowNull: true })
  declare source: string | null;

  /** 绝对路径；重试索引时重新从这里读文件解析 */
  @Column({ type: DataType.STRING(1000), allowNull: true })
  declare file_path: string | null;

  @Index({ name: 'idx_documents_status' })
  @Column({
    type: DataType.ENUM('uploaded', 'indexing', 'ready', 'failed'),
    allowNull: false,
    defaultValue: 'uploaded',
  })
  declare status: DocumentStatus;

  /** 索引完成后回填：Qdrant 里 doc_id 对应的点数 */
  @Default(0)
  @Column({ type: DataType.INTEGER })
  declare chunk_count: number;

  /** status=failed 时给前端展示的错误摘要（完整堆栈只进日志） */
  @Column({ type: DataType.STRING(1000), allowNull: true })
  declare error_message: string | null;

  @Column({ type: DataType.JSON })
  declare metadata: DocumentMetadata | null;

  /** 上传者 user_id（admin 角色） */
  @Column({ type: DataType.STRING(36), allowNull: true })
  declare uploaded_by: string | null;

  @CreatedAt
  @Column({ type: DataType.DATE(6) })
  declare uploaded_at: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE(6) })
  declare updated_at: Date;

  @BeforeCreate
  static generateId(instance: Document): void {
    if (!instance.id) {
      instance.id = nanoid(21);
    }
  }
}