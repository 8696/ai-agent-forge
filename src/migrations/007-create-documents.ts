import { DataTypes, type QueryInterface } from 'sequelize';
import type { MigrationFn } from 'umzug';
import { tableExists } from './helpers/schema';

/**
 * 知识库文档表（documents）—— 详见 docs/05-a-数据模型-mysql.md §知识库文档表
 *
 * 设计要点：
 *  - 本表只存**元数据**，向量存 Qdrant（docs/05-b §5.6）；两边靠 `id` ↔ payload.doc_id 关联
 *  - status 流转 uploaded → indexing → ready / failed，由 src/rag/ingest.ts 维护
 *  - chunk_count 索引完成后回填，跟 Qdrant 里该 doc_id 的点数对齐
 *  - file_type ENUM 保留 'word'（docs/05-a 原定），但当前上传只放行 pdf / markdown / txt
 *  - idx_tenant_uploaded：文档列表默认按「租户 + 上传时间倒序」翻页
 *  - idx_status：失败重试 / 状态筛选
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  // 表已经存在就直接跳过：开发库上可能留着一张更早版本建的 documents 表
  // （schema 少几个字段）。这里不硬建，紧接着的 008 会把缺的列补齐。
  if (await tableExists(queryInterface, 'documents')) {
    return;
  }

  await queryInterface.createTable('documents', {
    id: {
      type: DataTypes.STRING(36),
      primaryKey: true,
      comment: '文档 ID（nanoid(21)，与 Qdrant payload.doc_id 对应）',
    },
    tenant_id: {
      type: DataTypes.STRING(36),
      allowNull: false,
      comment: '所属租户',
      references: { model: 'tenants', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    title: {
      type: DataTypes.STRING(500),
      allowNull: false,
      comment: '文档标题（原始文件名）',
    },
    source: {
      type: DataTypes.STRING(500),
      allowNull: true,
      comment: '磁盘存储文件名（相对 DATA_DIR/uploads/{tenant_id}/）',
    },
    file_type: {
      type: DataTypes.ENUM('pdf', 'word', 'markdown', 'txt'),
      allowNull: true,
      comment: '文件类型',
    },
    file_path: {
      type: DataTypes.STRING(1000),
      allowNull: true,
      comment: '完整磁盘路径（绝对路径，重试索引时重新解析用）',
    },
    status: {
      type: DataTypes.ENUM('uploaded', 'indexing', 'ready', 'failed'),
      allowNull: false,
      defaultValue: 'uploaded',
      comment: '索引状态',
    },
    chunk_count: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: '已分块的块数（索引完成后回填）',
    },
    error_message: {
      type: DataTypes.STRING(1000),
      allowNull: true,
      comment: '最近一次索引失败的错误摘要（status=failed 时给前端展示）',
    },
    metadata: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: '元数据（标签 / 部门 / 业务字段）',
    },
    uploaded_by: {
      type: DataTypes.STRING(36),
      allowNull: true,
      comment: '上传者 user_id',
    },
    uploaded_at: {
      type: DataTypes.DATE(6),
      allowNull: false,
      defaultValue: queryInterface.sequelize.literal('CURRENT_TIMESTAMP(6)'),
      comment: '上传时间',
    },
    updated_at: {
      type: DataTypes.DATE(6),
      allowNull: false,
      defaultValue: queryInterface.sequelize.literal('CURRENT_TIMESTAMP(6)'),
      comment: '更新时间',
    },
  });

  await queryInterface.addIndex('documents', ['tenant_id', 'uploaded_at'], {
    name: 'idx_documents_tenant_uploaded',
  });
  await queryInterface.addIndex('documents', ['status'], {
    name: 'idx_documents_status',
  });

  await queryInterface.sequelize.query(
    "ALTER TABLE documents COMMENT = '知识库文档元数据表（向量存 Qdrant）'",
  );
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.dropTable('documents');
};