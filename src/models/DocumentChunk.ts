import {
  Table,
  Column,
  Model,
  PrimaryKey,
  Default,
  DataType,
  CreatedAt,
  UpdatedAt,
  ForeignKey,
  Index,
  BeforeCreate,
} from 'sequelize-typescript';
import { nanoid } from 'nanoid';
import { Tenant } from './Tenant';

/**
 * 文档切片的**权威副本**（迁移 036）
 *
 * ## 为什么要有这张表
 *
 * 切片的正文以前**只有一份真身，在 Qdrant 的 payload 里**。
 * 那对「查看」够用，对「编辑」不够：
 *
 *   - Qdrant 不是 CMS —— 没事务、没版本、没法撤销
 *   - point id 是 `randomUUID()`，跟 `chunk_index` 没有稳定映射 → 改第 5 块要先翻出它的 id
 *   - 「重新索引」= 从磁盘原文件重切 + `deleteDocumentPoints` → **静默吃掉所有人工编辑**
 *
 * 所以把正文的权威副本落到 MySQL，Qdrant 只当**检索索引**。
 *
 * ## 一行是什么
 *
 * 一行 = 一篇文档的一个块。`text` 是**最终进向量的完整文本**
 * （面包屑 + 重叠区 + 正文，跟 Qdrant payload.text 一致）。
 *
 * ## 三组列
 *
 * | 列 | 作用 |
 * |---|---|
 * | `text` / `generated_text` | 当前文本 / 最近一次由程序生成的文本（`generated_text` 是**还原**的依据） |
 * | `heading_path` | 该块所属的标题层级路径（面包屑的来源） |
 * | `source_char_start` / `source_char_end` | 这块在**归一化原文**里的区间 —— 重新索引时用它把人工编辑对回新块 |
 * | `edited` / `edited_by` / `edited_at` | 有没有被人工干预过 / 谁改的 / 什么时候 |
 *
 * ⚠️ **人工编辑之后 `source_char_*` 只是参考** —— 编辑后的文字不再对应原文。
 *    它的价值在「切法没变时，重新索引能把编辑原样搬回去」。
 *
 * ## 租户隔离
 *
 * 带 `tenant_id` 列 → Sequelize 的租户作用域钩子（src/lib/tenant-scope.ts）
 * 自动补过滤，**忘了加过滤也不会跨租户**。
 */
@Table({ tableName: 'document_chunks' })
export class DocumentChunk extends Model {
  @PrimaryKey
  @Default(() => nanoid(21))
  @Column({ type: DataType.STRING(36) })
  declare id: string;

  @ForeignKey(() => Tenant)
  @Index({ name: 'idx_document_chunks_tenant_doc' })
  @Column({ type: DataType.STRING(36), allowNull: false })
  declare tenant_id: string;

  /** 所属文档（documents.id） */
  @Index({ name: 'idx_document_chunks_document' })
  @Column({ type: DataType.STRING(36), allowNull: false })
  declare document_id: string;

  /** 块序号，0-based —— 同一篇文档内连续 */
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare chunk_index: number;

  /** 最终进向量的完整文本（面包屑 + 重叠区 + 正文） */
  @Column({ type: DataType.TEXT('medium'), allowNull: false })
  declare text: string;

  /**
   * **最近一次由切块器（或结构操作）产生的文本** —— 「还原」的依据。
   *
   * - 索引时：generated_text = text = 切块器的输出
   * - 改文字时：text 变，generated_text **不动** → 「还原」= text = generated_text
   * - 拆分 / 合块时：新块的 generated_text = 拆分/合并那一刻的文本
   *   （结构是人挑的，文字随之固化）
   *
   * ⚠️ **不是「原始切块文本」** —— 拆过 / 合过之后原件已经不存在了，
   *    存一份「上一次由程序生成的文本」比硬撑「原始」更诚实。
   */
  @Column({ type: DataType.TEXT('medium'), allowNull: false })
  declare generated_text: string;

  /** 该块所属的标题层级路径（面包屑的来源）；老数据可能为 null */
  @Column({ type: DataType.JSON, allowNull: true })
  declare heading_path: string[] | null;

  /** 这块在归一化原文里的起始位置（人工编辑后仅供参考） */
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare source_char_start: number;

  /** 这块在归一化原文里的结束位置（人工编辑后仅供参考） */
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare source_char_end: number;

  /** 有没有被人工改过 */
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare edited: boolean;

  /** 该块是本节第几块（1 起） */
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare section_chunk_index: number;

  /** 本节一共切成了几块 */
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare section_chunk_total: number;

  /** 谁改的（admin 用户 id） */
  @Column({ type: DataType.STRING(36), allowNull: true })
  declare edited_by: string | null;

  /** 什么时候改的 */
  @Column({ type: DataType.DATE(6), allowNull: true })
  declare edited_at: Date | null;

  @CreatedAt
  @Column({ type: DataType.DATE(6) })
  declare created_at: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE(6) })
  declare updated_at: Date;

  @BeforeCreate
  static generateId(instance: DocumentChunk): void {
    if (!instance.id) {
      instance.id = nanoid(21);
    }
  }
}
