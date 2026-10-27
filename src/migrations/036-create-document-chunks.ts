import { DataTypes, type QueryInterface } from 'sequelize';
import type { MigrationFn } from 'umzug';
import { tableExists } from './helpers/schema';

/**
 * 文档切片表（document_chunks）—— 切片的**权威副本**（迁移 036）
 *
 * ## 为什么要有这张表
 *
 * 切片的正文以前**只有一份真身，在 Qdrant 的 payload 里**。
 * 对「查看」够用，对「编辑」不够：
 *
 *   - Qdrant 不是 CMS —— 没事务、没版本、没法撤销
 *   - point id 是 `randomUUID()`，跟 `chunk_index` 没有稳定映射
 *   - 「重新索引」= 从磁盘原文件重切 + `deleteDocumentPoints`
 *     → **静默吃掉所有人工编辑**（用户精心调了 10 块，点一下重索引全没了）
 *
 * 把正文的权威副本落到 MySQL，Qdrant 只当**检索索引**。
 *
 * ## 列
 *
 *  - `document_id` / `tenant_id` —— 归属
 *  - `chunk_index` —— 块序号（0-based，同一篇文档内连续）
 *  - `text` —— **最终进向量的完整文本**（面包屑 + 重叠区 + 正文）
 *  - `generated_text` —— 最近一次由程序生成的文本，**还原的依据**
 *    （改文字时它不动；拆分 / 合块时新块取拆分/合并那一刻的文本）
 *  - `heading_path` —— 标题层级路径（面包屑的来源）
 *  - `source_char_start` / `source_char_end` —— 这块在归一化原文里的区间
 *    → 重新索引时用它把人工编辑对回新块（切法没变时区间完全一致）
 *  - `edited` / `edited_by` / `edited_at` —— 人工编辑的痕迹
 *
 * ## 索引
 *
 *  - UNIQUE (tenant_id, document_id, chunk_index) —— 一篇文档内块序号唯一
 *  - idx_document_chunks_document (document_id, chunk_index) —— 按文档拉全部块
 *
 * ⚠️ **不加外键**（跟 cost_logs / traces / tool_call_logs 一致）：外键只拖慢写入。
 *
 * 幂等：表已存在就跳过。
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  if (await tableExists(queryInterface, 'document_chunks')) {
    return;
  }

  await queryInterface.createTable('document_chunks', {
    id: {
      type: DataTypes.STRING(36),
      primaryKey: true,
      allowNull: false,
      comment: '块 id（nanoid 21）',
    },
    tenant_id: {
      type: DataTypes.STRING(36),
      allowNull: false,
      comment: '所属租户',
    },
    document_id: {
      type: DataTypes.STRING(36),
      allowNull: false,
      comment: '所属文档（documents.id）',
    },
    chunk_index: {
      type: DataTypes.INTEGER,
      allowNull: false,
      comment: '块序号（0-based，同一篇文档内连续）',
    },
    text: {
      type: DataTypes.TEXT('medium'),
      allowNull: false,
      comment: '最终进向量的完整文本（面包屑 + 重叠区 + 正文）',
    },
    generated_text: {
      type: DataTypes.TEXT('medium'),
      allowNull: false,
      comment: '最近一次由程序生成的文本 —— 「还原」的依据',
    },
    heading_path: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: '标题层级路径（面包屑的来源）',
    },
    source_char_start: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: '在归一化原文里的起始位置（人工编辑后仅供参考）',
    },
    source_char_end: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: '在归一化原文里的结束位置（人工编辑后仅供参考）',
    },
    edited: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment: '有没有被人工改过',
    },
    section_chunk_index: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: '该块是本节第几块（1 起）',
    },
    section_chunk_total: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: '本节一共切成了几块',
    },
    edited_by: {
      type: DataTypes.STRING(36),
      allowNull: true,
      comment: '谁改的（admin 用户 id）',
    },
    edited_at: {
      type: DataTypes.DATE(6),
      allowNull: true,
      comment: '什么时候改的',
    },
    created_at: {
      type: DataTypes.DATE(6),
      allowNull: false,
      defaultValue: queryInterface.sequelize.literal('CURRENT_TIMESTAMP(6)'),
      comment: '创建时间',
    },
    updated_at: {
      type: DataTypes.DATE(6),
      allowNull: false,
      defaultValue: queryInterface.sequelize.literal('CURRENT_TIMESTAMP(6)'),
      comment: '更新时间',
    },
  });

  await queryInterface.addIndex('document_chunks', ['tenant_id', 'document_id', 'chunk_index'], {
    name: 'idx_document_chunks_unique',
    unique: true,
  });
  await queryInterface.addIndex('document_chunks', ['document_id', 'chunk_index'], {
    name: 'idx_document_chunks_document',
  });

  // 字符集 / 引擎显式规范（迁移 027 的约定：建表不依赖数据库默认值）
  await queryInterface.sequelize.query(
    "ALTER TABLE document_chunks CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci, " +
      'ENGINE=InnoDB',
  );
  await queryInterface.sequelize.query(
    "ALTER TABLE document_chunks COMMENT = '文档切片表 —— 切片的权威副本（Qdrant 只是检索索引）'",
  );
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.dropTable('document_chunks');
};
