import { DataTypes, QueryTypes, type QueryInterface } from 'sequelize';
import type { MigrationFn } from 'umzug';

/**
 * 租户配置重构：两张专用表 → 「模型列表 + 通用 KV」
 *
 * 起因：`/admin/model` 一页里混着模型连接、采样参数、检索条数、历史轮数，
 * 东西一多就不知道该往哪放。按「不同形态用不同页面 + 不同存储」拆：
 *
 *   新 tenant_models     租户模型列表（多条 + is_active），每条完整连接配置
 *   新 tenant_settings   通用配置 KV（检索条数 / 历史轮数，后续再加）
 *   删 tenant_llm_configs / tenant_chat_settings
 *
 * 迁移顺序（幂等）：
 *   1. 建两张新表
 *   2. 搬数据：
 *      - 旧 tenant_llm_configs 每行 → 一条 tenant_models
 *        （表名不带名字，用 provider 或 model_id 起个默认名；只要有启用模型就 is_active）
 *      - 旧 tenant_chat_settings 每行 → N 条 tenant_settings（KV 表天然一对多）
 *   3. drop 旧两张表
 *
 * **对外 API 契约不变**：`GET /api/v1/admin/config/llm` 的响应体字段一模一样，
 * 服务层把「启用中的模型 + KV 值」合成同一个视图，前端不用大改。
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.createTable('tenant_models', {
    id: { type: DataTypes.STRING(36), primaryKey: true, comment: '模型条目 ID（nanoid(21)）' },
    tenant_id: {
      type: DataTypes.STRING(36),
      allowNull: false,
      comment: '所属租户',
      references: { model: 'tenants', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    name: { type: DataTypes.STRING(100), allowNull: false, comment: '条目名（租户自定义）' },
    provider: { type: DataTypes.STRING(32), allowNull: true, comment: '展示用标识，不参与调用' },
    model_id: { type: DataTypes.STRING(100), allowNull: false, comment: '对话模型 id' },
    base_url: {
      type: DataTypes.STRING(500),
      allowNull: false,
      comment: 'Anthropic 协议端点（已 normalize 成以 /v1 结尾）',
    },
    api_key_enc: {
      type: DataTypes.BLOB,
      allowNull: false,
      comment: 'AES-256-GCM 密文；密钥来自 CONFIG_ENCRYPTION_KEY',
    },
    api_key_hint: {
      type: DataTypes.STRING(64),
      allowNull: true,
      comment: '脱敏提示，唯一允许回显的密钥形态',
    },
    temperature: { type: DataTypes.DECIMAL(3, 2), allowNull: true, comment: 'NULL = 用进程级默认' },
    max_output_tokens: { type: DataTypes.INTEGER, allowNull: true, comment: 'NULL = 用进程级默认' },
    prompt_cache_enabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
      comment: '是否给系统提示词打 cacheControl',
    },
    is_active: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment: '是否是对话当前使用的模型；每租户恰有一条为 true',
    },
    updated_by: { type: DataTypes.STRING(36), allowNull: true, comment: '最后修改人 user_id' },
    created_at: {
      type: DataTypes.DATE(6),
      allowNull: false,
      defaultValue: queryInterface.sequelize.literal('CURRENT_TIMESTAMP(6)'),
      comment: '创建时间',
    },
    updated_at: {
      type: DataTypes.DATE(6),
      allowNull: false,
      defaultValue: queryInterface.sequelize.literal('CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)'),
      comment: '更新时间',
    },
  });
  await queryInterface.addIndex('tenant_models', ['tenant_id'], { name: 'idx_tenant_models_tenant' });
  await queryInterface.sequelize.query(
    "ALTER TABLE tenant_models COMMENT = '租户模型列表（每租户多条，is_active 标记当前使用）'",
  );

  await queryInterface.createTable('tenant_settings', {
    id: { type: DataTypes.STRING(36), primaryKey: true, comment: '配置行 ID（nanoid(21)）' },
    tenant_id: {
      type: DataTypes.STRING(36),
      allowNull: false,
      comment: '所属租户',
      references: { model: 'tenants', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    config_key: { type: DataTypes.STRING(64), allowNull: false, comment: '配置项键（对应 SETTINGS_REGISTRY）' },
    config_value: { type: DataTypes.STRING(1000), allowNull: false, comment: '值（统一字符串，类型由 registry 决定）' },
    updated_by: { type: DataTypes.STRING(36), allowNull: true, comment: '最后修改人 user_id' },
    created_at: {
      type: DataTypes.DATE(6),
      allowNull: false,
      defaultValue: queryInterface.sequelize.literal('CURRENT_TIMESTAMP(6)'),
      comment: '创建时间',
    },
    updated_at: {
      type: DataTypes.DATE(6),
      allowNull: false,
      defaultValue: queryInterface.sequelize.literal('CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)'),
      comment: '更新时间',
    },
  });
  await queryInterface.addIndex('tenant_settings', ['tenant_id', 'config_key'], {
    name: 'uk_tenant_settings_key',
    unique: true,
  });
  await queryInterface.sequelize.query(
    "ALTER TABLE tenant_settings COMMENT = '租户通用配置 KV（只存租户改过的值）'",
  );

  // ---- 搬数据 ----

  // 旧 LLM 配置 → 模型列表。
  // 没有 model_id 或 base_url 的行搬不了（新表这两列 NOT NULL）——那种行本来
  // 也调不通（对话会回落 .env 默认），丢了不影响行为。
  if (await tableExistsSafe(queryInterface, 'tenant_llm_configs')) {
    await queryInterface.sequelize.query(
      `INSERT INTO tenant_models
         (id, tenant_id, name, provider, model_id, base_url, api_key_enc, api_key_hint,
          temperature, max_output_tokens, prompt_cache_enabled, is_active, updated_by, created_at, updated_at)
       SELECT UUID(), tenant_id,
              COALESCE(NULLIF(provider, ''), NULLIF(model_id, ''), '默认模型'),
              provider, model_id, base_url, api_key_enc, api_key_hint,
              temperature, max_output_tokens, prompt_cache_enabled,
              1,                                  -- 旧表只有一份配置 → 它就是启用项
              updated_by, created_at, updated_at
         FROM tenant_llm_configs
        WHERE model_id IS NOT NULL AND model_id <> ''
          AND base_url IS NOT NULL AND base_url <> ''
          AND api_key_enc IS NOT NULL
          AND tenant_id NOT IN (SELECT tenant_id FROM tenant_models)`,
    );
  }

  // 旧对话参数 → KV
  if (await tableExistsSafe(queryInterface, 'tenant_chat_settings')) {
    const moved: Array<[string, string]> = [
      ['prompt_version', 'prompt_version'],
      ['retrieval_top_k', 'retrieval_top_k'],
      ['max_history_turns', 'max_history_turns'],
    ];
    for (const [column, key] of moved) {
      const has = await columnExists(queryInterface, 'tenant_chat_settings', column);
      if (!has) {
        continue;
      }
      await queryInterface.sequelize.query(
        `INSERT INTO tenant_settings (id, tenant_id, config_key, config_value, updated_by, created_at, updated_at)
         SELECT UUID(), tenant_id, ?, CAST(\`${column}\` AS CHAR), updated_by, created_at, updated_at
           FROM tenant_chat_settings
          WHERE \`${column}\` IS NOT NULL
            AND tenant_id NOT IN (
              SELECT tenant_id FROM tenant_settings WHERE config_key = ?
            )`,
        { replacements: [key, key] },
      );
    }
  }

  // ---- 删旧表 ----
  if (await tableExistsSafe(queryInterface, 'tenant_llm_configs')) {
    await queryInterface.dropTable('tenant_llm_configs');
  }
  if (await tableExistsSafe(queryInterface, 'tenant_chat_settings')) {
    await queryInterface.dropTable('tenant_chat_settings');
  }
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  // 反向重建 + 搬回，逻辑与 up 镜像
  await queryInterface.createTable('tenant_llm_configs', {
    id: { type: DataTypes.STRING(36), primaryKey: true, comment: '配置 ID' },
    tenant_id: {
      type: DataTypes.STRING(36),
      allowNull: false,
      references: { model: 'tenants', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    provider: { type: DataTypes.STRING(32), allowNull: true },
    model_id: { type: DataTypes.STRING(100), allowNull: true },
    base_url: { type: DataTypes.STRING(500), allowNull: true },
    api_key_enc: { type: DataTypes.BLOB, allowNull: true },
    api_key_hint: { type: DataTypes.STRING(64), allowNull: true },
    temperature: { type: DataTypes.DECIMAL(3, 2), allowNull: true },
    max_output_tokens: { type: DataTypes.INTEGER, allowNull: true },
    prompt_cache_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    updated_by: { type: DataTypes.STRING(36), allowNull: true },
    created_at: {
      type: DataTypes.DATE(6),
      allowNull: false,
      defaultValue: queryInterface.sequelize.literal('CURRENT_TIMESTAMP(6)'),
    },
    updated_at: {
      type: DataTypes.DATE(6),
      allowNull: false,
      defaultValue: queryInterface.sequelize.literal('CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)'),
    },
  });
  await queryInterface.sequelize.query(
    `INSERT INTO tenant_llm_configs
       (id, tenant_id, provider, model_id, base_url, api_key_enc, api_key_hint,
        temperature, max_output_tokens, prompt_cache_enabled, updated_by, created_at, updated_at)
     SELECT UUID(), tenant_id, provider, model_id, base_url, api_key_enc, api_key_hint,
            temperature, max_output_tokens, prompt_cache_enabled, updated_by, created_at, updated_at
       FROM tenant_models WHERE is_active = 1`,
  );

  await queryInterface.createTable('tenant_chat_settings', {
    id: { type: DataTypes.STRING(36), primaryKey: true, comment: '配置 ID' },
    tenant_id: {
      type: DataTypes.STRING(36),
      allowNull: false,
      references: { model: 'tenants', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    prompt_version: { type: DataTypes.STRING(20), allowNull: true },
    retrieval_top_k: { type: DataTypes.INTEGER, allowNull: true },
    max_history_turns: { type: DataTypes.INTEGER, allowNull: true },
    updated_by: { type: DataTypes.STRING(36), allowNull: true },
    created_at: {
      type: DataTypes.DATE(6),
      allowNull: false,
      defaultValue: queryInterface.sequelize.literal('CURRENT_TIMESTAMP(6)'),
    },
    updated_at: {
      type: DataTypes.DATE(6),
      allowNull: false,
      defaultValue: queryInterface.sequelize.literal('CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)'),
    },
  });
  await queryInterface.sequelize.query(
    `INSERT INTO tenant_chat_settings (id, tenant_id, prompt_version, retrieval_top_k, max_history_turns, updated_by, created_at, updated_at)
     SELECT UUID(), tenant_id,
            (SELECT config_value FROM tenant_settings WHERE tenant_id = t.tenant_id AND config_key = 'prompt_version' LIMIT 1),
            (SELECT config_value FROM tenant_settings WHERE tenant_id = t.tenant_id AND config_key = 'retrieval_top_k' LIMIT 1),
            (SELECT config_value FROM tenant_settings WHERE tenant_id = t.tenant_id AND config_key = 'max_history_turns' LIMIT 1),
            updated_by, created_at, updated_at
       FROM (SELECT DISTINCT tenant_id, updated_by, created_at, updated_at FROM tenant_settings) t`,
  );

  await queryInterface.dropTable('tenant_models');
  await queryInterface.dropTable('tenant_settings');
};

async function tableExistsSafe(queryInterface: QueryInterface, table: string): Promise<boolean> {
  const rows = await queryInterface.sequelize.query<{ n: number }>(
    'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    { replacements: [table], type: QueryTypes.SELECT },
  );
  return rows.length > 0 && Number(rows[0]?.n ?? 0) > 0;
}

async function columnExists(
  queryInterface: QueryInterface,
  table: string,
  column: string,
): Promise<boolean> {
  const rows = await queryInterface.sequelize.query<{ COLUMN_NAME: string }>(
    'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    { replacements: [table, column], type: QueryTypes.SELECT },
  );
  return rows.length > 0;
}