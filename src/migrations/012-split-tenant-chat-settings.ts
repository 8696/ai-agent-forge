import { DataTypes, type QueryInterface } from 'sequelize';
import type { MigrationFn } from 'umzug';
import { tableExists, listColumns } from './helpers/schema';

/**
 * 把 tenant_llm_configs 拆成两张表
 *
 * 起因：`tenant_llm_configs` 一半装「怎么调 LLM」（端点/密钥/模型/采样），
 * 一半装「回答得像不像样」（提示词版本/检索广度/历史长度）。名字已经名不副实，
 * 下次再加配置项就没人知道该放哪了。所以拆：
 *
 *   tenant_llm_configs   → 保留：provider / model_id / base_url / api_key_* /
 *                               temperature / max_output_tokens / prompt_cache_enabled
 *   tenant_chat_settings → 新建：prompt_version / retrieval_top_k / max_history_turns
 *
 * 步骤（幂等，兼容 010/011 没跑全的老库）：
 *   1. 建 tenant_chat_settings（已存在就跳过）
 *   2. 把老表里那三列的数据搬过去（搬完才删列，避免丢数据）
 *   3. 从 tenant_llm_configs 删掉那三列
 *
 * 为什么是「新建迁移」而不是改 010/011：010/011 已经在别的库上执行过了
 * （同 008-converge-documents-schema 的理由）。改历史迁移会让后来拉分支的人
 * 对不上 schema。
 *
 * **对外 API 契约不变** —— 后端服务层把两张表合成一个对象，`/config/llm`
 * 的响应体字段一模一样，前端不用改。
 */

/** 从老表搬到新表的三列 */
const MOVED_COLUMNS = ['prompt_version', 'retrieval_top_k', 'max_history_turns'] as const;

export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  const newTableReady = await tableExists(queryInterface, 'tenant_chat_settings');
  if (!newTableReady) {
    await queryInterface.createTable('tenant_chat_settings', {
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
      prompt_version: {
        type: DataTypes.STRING(20),
        allowNull: true,
        comment: '当前生效的提示词版本号（C3）；NULL = 用内置默认提示词',
      },
      retrieval_top_k: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: '检索召回的候选块数；NULL = 用进程级 CHAT_RETRIEVAL_TOP_K',
      },
      max_history_turns: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: '最多带多少轮历史进提示词；NULL = 用进程级 CHAT_MAX_HISTORY_TURNS',
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
        defaultValue: queryInterface.sequelize.literal(
          'CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)',
        ),
        comment: '更新时间',
      },
    });
    await queryInterface.addIndex('tenant_chat_settings', ['tenant_id'], {
      name: 'uk_tenant_chat_settings_tenant',
      unique: true,
    });
    await queryInterface.sequelize.query(
      "ALTER TABLE tenant_chat_settings COMMENT = '租户级对话参数（提示词版本 / 检索广度 / 历史长度）'",
    );
  }

  // 老表不存在 = 全新库（010 已经建了新表），无事可做
  if (!(await tableExists(queryInterface, 'tenant_llm_configs'))) {
    return;
  }
  const oldColumns = await listColumns(queryInterface, 'tenant_llm_configs');
  const present = MOVED_COLUMNS.filter((c) => oldColumns.has(c));
  if (present.length === 0) {
    return; // 已经拆过了（幂等）
  }

  // 搬数据：老表里每行对应租户，新表同样每租户一行。
  // 三列全为 NULL 的行不搬 —— 搬了也只是多一条空记录，没有信息量。
  const columnList = present.join(', ');
  await queryInterface.sequelize.query(
    `INSERT INTO tenant_chat_settings (id, tenant_id, ${columnList}, updated_by, created_at, updated_at)
     SELECT UUID(), tenant_id, ${columnList}, updated_by, created_at, updated_at
       FROM tenant_llm_configs
      WHERE ${present.map((c) => `${c} IS NOT NULL`).join(' OR ')}
        AND tenant_id NOT IN (SELECT tenant_id FROM tenant_chat_settings)`,
  );

  for (const column of present) {
    await queryInterface.removeColumn('tenant_llm_configs', column);
  }
  await queryInterface.sequelize.query(
    "ALTER TABLE tenant_llm_configs COMMENT = '租户级 LLM 配置（端点 / 密钥 / 模型 / 采样参数）'",
  );
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  if (!(await tableExists(queryInterface, 'tenant_llm_configs'))) {
    return;
  }
  // 把三列加回老表，再把数据搬回去（顺序与 up 相反：先加列才能搬）
  for (const column of MOVED_COLUMNS) {
    const existing = await listColumns(queryInterface, 'tenant_llm_configs');
    if (existing.has(column)) {
      continue;
    }
    if (column === 'prompt_version') {
      await queryInterface.addColumn('tenant_llm_configs', column, {
        type: DataTypes.STRING(20),
        allowNull: true,
        comment: '当前生效的提示词版本号',
      });
    } else {
      await queryInterface.addColumn('tenant_llm_configs', column, {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: '对话参数（见 docs/12-c §C4）',
      });
    }
  }

  if (await tableExists(queryInterface, 'tenant_chat_settings')) {
    await queryInterface.sequelize.query(
      `UPDATE tenant_llm_configs l
          JOIN tenant_chat_settings s ON s.tenant_id = l.tenant_id
          SET l.${MOVED_COLUMNS.map((c) => `\`${c}\` = s.\`${c}\``).join(', ')}`,
    );
    await queryInterface.dropTable('tenant_chat_settings');
  }
};