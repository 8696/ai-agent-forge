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
 * 文档索引状态机（见 docs/05-a §5.1 `documents.status` + docs/15 §Step 4）
 *
 *  uploaded → indexing → ready
 *           ↘          ↘
 *             failed    failed
 *
 * Step 4 同步处理：上传完后 API 同步跑分块 + Embedding + 入向量库，
 *   所以前端实际只看到 indexing → ready / failed；uploaded 只是「先建行再处理」时的初值。
 */
export type DocumentStatus = 'uploaded' | 'indexing' | 'ready' | 'failed';

/** docs/05-a §5.1 文档元数据 JSON 列允许存的键 */
export interface DocumentMetadata {
  /** 原始文件名 / 摘要 / 业务字段 */
  [key: string]: unknown;
}

/**
 * 知识库文档元数据表（DDL 见 docs/05-a-数据模型-mysql.md §5.1）
 *
 * - 一个租户的所有文档元数据都在这张表（向量实际存 Qdrant，关联字段是 id）
 * - `status` 流转由 src/rag/ingest.ts 维护
 * - `chunk_count` 索引完成后回填（与 Qdrant 里 doc_id 对应的点数对齐）
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

  /** 原始文件名（= 标题，便于 UI 显示） */
  @Column({ type: DataType.STRING(500), allowNull: false })
  declare title: string;

  /** 文件类型；前端 UI 按这个着色 / 筛选 */
  @Column({
    type: DataType.ENUM('pdf', 'word', 'markdown', 'txt'),
    allowNull: true,
  })
  declare file_type: 'pdf' | 'word' | 'markdown' | 'txt' | null;

  /** 本地存储路径（./data/uploads/{tenant_id}/{nanoid}.{ext}） */
  @Column({ type: DataType.STRING(500), allowNull: true })
  declare source: string | null;

  /** 完整磁盘路径（绝对路径，给拆块 / 解析用） */
  @Column({ type: DataType.STRING(1000), allowNull: true })
  declare file_path: string | null;

  @Index({ name: 'idx_documents_status' })
  @Column({
    type: DataType.ENUM('uploaded', 'indexing', 'ready', 'failed'),
    allowNull: false,
    defaultValue: 'uploaded',
  })
  declare status: DocumentStatus;

  /** 索引完成回填：Qdrant 里 doc_id 对应的点数（同步处理时一次写入） */
  @Default(0)
  @Column({ type: DataType.INTEGER })
  declare chunk_count: number;

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