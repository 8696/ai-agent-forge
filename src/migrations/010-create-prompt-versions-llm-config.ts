import { DataTypes, type QueryInterface } from 'sequelize';
import type { MigrationFn } from 'umzug';

/**
 * 提示词版本表 + 租户 LLM 配置表 —— 详见 docs/12-c-需求-管理员可配置.md §C3 / §C4
 *
 * 为什么要这两张表：
 *  - prompt_versions：**每个租户自己一套提示词**，多版本并存，draft → production → archived，
 *    可发布可回滚。`content` 存正文（所以后台能直接编辑，而不是改代码文件）。
 *    —— 这是对 docs/05-a 原定 DDL 的改动：原设计只有 `file_path` 指向仓库里的 .ts 文件，
 *    那样后台只能「选版本」不能「编版本」，改提示词还得发版。租户级自定义要求正文入库。
 *  - tenant_llm_configs：租户级的模型选择。`.env` 的 provider 配置是**进程级默认值**，
 *    这张表是**租户级覆盖**，两层的优先级在 src/services/llm-settings.ts 里定。
 *    apiKey 存 AES-256-GCM 密文（CONFIG_ENCRYPTION_KEY），另有 api_key_hint 存脱敏串供 UI 回显，
 *    **接口永不返回明文密钥**。
 *
 * 两张表都按 tenant_id CASCADE：删租户连带清干净。
 * 每租户只允许一条 LLM 配置（uk_tenant 单列唯一），提示词版本则每租户多条（uk_tenant_version）。
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.createTable('prompt_versions', {
    id: {
      type: DataTypes.STRING(36),
      primaryKey: true,
      comment: '版本 ID（nanoid(21)）',
    },
    tenant_id: {
      type: DataTypes.STRING(36),
      allowNull: false,
      comment: '所属租户',
      references: { model: 'tenants', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    version: {
      type: DataTypes.STRING(20),
      allowNull: false,
      comment: '版本号（v1 / v2 …，租户内唯一）',
    },
    status: {
      type: DataTypes.ENUM('draft', 'production', 'archived'),
      allowNull: false,
      defaultValue: 'draft',
      comment: '生产中 / 草稿 / 已归档',
    },
    content: {
      type: DataTypes.TEXT('medium'),
      allowNull: false,
      comment: '提示词正文，支持 {{tenantName}} 占位符',
    },
    description: {
      type: DataTypes.STRING(200),
      allowNull: true,
      comment: '这个版本改了什么（发布时给个说明，便于回溯）',
    },
    deployed_at: {
      type: DataTypes.DATE(6),
      allowNull: true,
      comment: '发布到生产的时间',
    },
    deployed_by: {
      type: DataTypes.STRING(36),
      allowNull: true,
      comment: '发布人 user_id',
    },
    created_by: {
      type: DataTypes.STRING(36),
      allowNull: false,
      comment: '创建人 user_id',
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
      defaultValue: queryInterface.sequelize.literal('CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)'),
      comment: '更新时间',
    },
  });

  await queryInterface.addIndex('prompt_versions', ['tenant_id', 'version'], {
    name: 'uk_prompt_versions_tenant_version',
    unique: true,
  });
  await queryInterface.addIndex('prompt_versions', ['tenant_id', 'status'], {
    name: 'idx_prompt_versions_tenant_status',
  });

  await queryInterface.sequelize.query(
    "ALTER TABLE prompt_versions COMMENT = '提示词版本表（租户级提示词，后台可编辑）'",
  );

  await queryInterface.createTable('tenant_llm_configs', {
    id: {
      type: DataTypes.STRING(36),
      primaryKey: true,
      comment: '配置 ID（nanoid(21)）',
    },
    tenant_id: {
      type: DataTypes.STRING(36),
      allowNull: false,
      comment: '所属租户（每租户一条）',
      references: { model: 'tenants', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    provider: {
      type: DataTypes.STRING(32),
      allowNull: true,
      comment: '展示用标识（zhipu / openai-compatible / 自填），仅供后台识别',
    },
    model_id: {
      type: DataTypes.STRING(100),
      allowNull: true,
      comment: '主对话模型 id；留空 = 用 .env 里的进程级默认',
    },
    base_url: {
      type: DataTypes.STRING(500),
      allowNull: true,
      comment: 'Anthropic 协议端点；留空 = 用 .env 里的进程级默认',
    },
    api_key_enc: {
      type: DataTypes.BLOB,
      allowNull: true,
      comment: 'AES-256-GCM 密文（iv + authTag + ciphertext）；密钥来自 CONFIG_ENCRYPTION_KEY',
    },
    api_key_hint: {
      type: DataTypes.STRING(64),
      allowNull: true,
      comment: '脱敏提示（如 sk-…4f2a），唯一允许回显的密钥形态',
    },
    temperature: {
      type: DataTypes.DECIMAL(3, 2),
      allowNull: true,
      comment: '生成温度；NULL = 用进程级默认',
    },
    max_output_tokens: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: '单次回复最大输出 token；NULL = 用进程级默认',
    },
    prompt_cache_enabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
      comment: '是否给系统提示词打 cacheControl（04-c §5.4.1「提示词缓存」开关）',
    },
    prompt_version: {
      type: DataTypes.STRING(20),
      allowNull: true,
      comment: '当前生效的提示词版本号；NULL = 用内置默认提示词',
    },
    updated_by: {
      type: DataTypes.STRING(36),
      allowNull: true,
      comment: '最后修改人 user_id',
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
      defaultValue: queryInterface.sequelize.literal('CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)'),
      comment: '更新时间',
    },
  });

  await queryInterface.addIndex('tenant_llm_configs', ['tenant_id'], {
    name: 'uk_tenant_llm_configs_tenant',
    unique: true,
  });

  await queryInterface.sequelize.query(
    "ALTER TABLE tenant_llm_configs COMMENT = '租户级 LLM 配置（覆盖 .env 进程级默认值）'",
  );
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  // 删表会连带删掉租户自定义的提示词正文和加密密钥，不可恢复。
  // 真要回滚走 `yarn migrate:undo` + 备份恢复（见 docs/13-扩展指南 §13.8）。
  await queryInterface.dropTable('tenant_llm_configs');
  await queryInterface.dropTable('prompt_versions');
};