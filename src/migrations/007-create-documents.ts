import { DataTypes, type QueryInterface } from 'sequelize';
import type { MigrationFn } from 'umzug';

/**
 * Step 4 · 知识库管理 —— 建 `documents` 表
 * 详见 docs/05-a-数据模型-mysql.md §5.1 + docs/15-开发进度计划.md §Step 4
 *
 * 关键设计：
 *  - status 流转：uploaded → indexing → ready / failed（同步处理；uploaded 是先建行的初值）
 *  - 索引 idx_tenant_uploaded：后台按租户 + 时间翻页
 *  - 索引 idx_status：按状态筛选（failed 重试 / indexing 看进度）
 *  - file_type ENUM 保留 'word' 是 docs/05 原有约定；Step 4 实际只接 PDF/MD/TXT（mammoth 未引入）
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.createTable('documents', {
    id: {
      type: DataTypes.STRING(36),
      primaryKey: true,
      comment: 'UUID',
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
      comment: '本地存储路径（./data/uploads/{tenant_id}/{nanoid}.{ext}）',
    },
    file_type: {
      type: DataTypes.ENUM('pdf', 'word', 'markdown', 'txt'),
      allowNull: true,
      comment: '文件类型',
    },
    file_path: {
      type: DataTypes.STRING(1000),
      allowNull: true,
      comment: '完整磁盘路径（绝对路径）',
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
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.dropTable('documents');
};