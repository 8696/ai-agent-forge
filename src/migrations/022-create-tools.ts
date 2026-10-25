import { DataTypes, type QueryInterface } from 'sequelize';
import type { MigrationFn } from 'umzug';
import { tableExists } from './helpers/schema';

/**
 * 工具注册表 —— C2 工具管理 / B3 工具调用
 * （详见 docs/12-c-需求-管理员可配置.md §C2、docs/12-b-需求-ai对话能力.md §B3）
 *
 * 一行 = 一个租户注册的工具。**实现放代码、注册放数据库**：
 * `config.builtin` 指向 `src/tools/builtin/registry.ts` 里的实现，
 * `description` 是给模型看的（租户能改 = 租户能调教模型调不调它）。
 *
 * 索引：
 *  - uk_tenant_name (tenant_id, name) —— 工具名租户内唯一（重名直接撞唯一键，端点层转 400）
 *  - idx_tenant_enabled (tenant_id, enabled) —— 每轮对话查「本租户启用的工具」
 *
 * 不加外键（跟 evaluation_* / cost_logs / traces 一致）：外键只会拖慢写入。
 *
 * 幂等：表已存在就跳过（createTable 生成的是 IF NOT EXISTS，
 * 随后的 addIndex 会撞 "Duplicate key name"，所以先查表在不在）。
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  if (await tableExists(queryInterface, 'tools')) {
    return;
  }

  await queryInterface.createTable('tools', {
    id: {
      type: DataTypes.STRING(36),
      primaryKey: true,
      allowNull: false,
      comment: '工具 id（nanoid 21）',
    },
    tenant_id: {
      type: DataTypes.STRING(36),
      allowNull: false,
      comment: '所属租户',
    },
    name: {
      type: DataTypes.STRING(100),
      allowNull: false,
      comment: '工具名（英文，模型调用时用的就是这个名字）',
    },
    description: {
      type: DataTypes.TEXT('medium'),
      allowNull: true,
      comment: '工具描述 —— 给 LLM 看，决定它调不调这个工具',
    },
    type: {
      type: DataTypes.ENUM('builtin', 'http', 'mcp'),
      allowNull: false,
      defaultValue: 'builtin',
      comment: 'builtin=平台内置；http=租户自己的 HTTP 接口；mcp=外部 MCP 服务',
    },
    config: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: '配置：builtin 装实现 key；http/mcp 装 url/method/headers/parameters',
    },
    enabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
      comment: '是否启用（关掉后下一轮对话的 tool 列表里就不含它）',
    },
    requires_confirmation: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment: '是否敏感操作（true 时模型调用它要先让用户确认）',
    },
    created_by: {
      type: DataTypes.STRING(36),
      allowNull: true,
      comment: '注册人 user id',
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

  await queryInterface.addIndex('tools', ['tenant_id', 'name'], {
    name: 'uk_tenant_name',
    unique: true,
  });
  await queryInterface.addIndex('tools', ['tenant_id', 'enabled'], {
    name: 'idx_tenant_enabled',
  });

  await queryInterface.sequelize.query(
    "ALTER TABLE tools COMMENT = '工具注册表（C2 工具管理 / B3 工具调用）'",
  );
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.dropTable('tools');
};
