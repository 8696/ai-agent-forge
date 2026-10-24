import { DataTypes, type QueryInterface } from 'sequelize';
import type { MigrationFn } from 'umzug';
import { tableExists } from './helpers/schema';

/**
 * 用户长期记忆表 —— B4 长期记忆（docs/12-b-需求-ai对话能力.md §B4）
 *
 * 一行 = 一条「关于这个用户的事实」。设计理由见 src/models/UserMemory.ts 的文件头。
 *
 * 索引：
 *  - (tenant_id, user_id) —— 主查询：取某个用户的记忆（注入提示词 / 我的记忆页）
 *  - (tenant_id, created_at) —— 租户后台按时间翻全租户的记忆
 *
 * 不加外键（跟 evaluation_* / cost_logs / traces 一致）：记忆要跨子系统查，
 * 外键只会拖慢写入。删除靠应用层 —— 删用户时应用层先把他的记忆归档。
 *
 * 幂等：createTable 生成的是 CREATE TABLE IF NOT EXISTS，表已存在时会静默跳过，
 * 随后的 addIndex 就会撞 "Duplicate key name"。所以先查表在不在。
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  if (await tableExists(queryInterface, 'user_memories')) {
    return;
  }

  await queryInterface.createTable('user_memories', {
    id: {
      type: DataTypes.STRING(36),
      primaryKey: true,
      allowNull: false,
      comment: '记忆 id（nanoid 21）',
    },
    tenant_id: {
      type: DataTypes.STRING(36),
      allowNull: false,
      comment: '所属租户',
    },
    user_id: {
      type: DataTypes.STRING(36),
      allowNull: false,
      comment: '记忆所属用户（用户级记忆：同一租户下不同用户互不可见）',
    },
    category: {
      type: DataTypes.ENUM('profile', 'preference', 'fact', 'context'),
      allowNull: false,
      defaultValue: 'fact',
      comment: '分类：画像 / 偏好 / 事实 / 情境',
    },
    content: {
      type: DataTypes.STRING(500),
      allowNull: false,
      comment: '记忆正文（一句话陈述）',
    },
    source: {
      type: DataTypes.ENUM('auto', 'user', 'admin'),
      allowNull: false,
      defaultValue: 'auto',
      comment: '来源：auto=模型自动抽取 / user=用户自己写 / admin=租户管理员写',
    },
    confidence: {
      type: DataTypes.FLOAT,
      allowNull: false,
      defaultValue: 0.5,
      comment: '抽取置信度 0~1；用户自己写的为 1',
    },
    status: {
      type: DataTypes.ENUM('active', 'archived'),
      allowNull: false,
      defaultValue: 'active',
      comment: '状态：active=生效中 / archived=已归档（软删，可恢复）',
    },
    hit_count: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: '被注入进提示词的次数',
    },
    last_hit_at: {
      type: DataTypes.DATE(6),
      allowNull: true,
      comment: '最后一次被注入的时间',
    },
    source_session_id: {
      type: DataTypes.STRING(36),
      allowNull: true,
      comment: '抽取来源会话 id（回溯当时的原话用）',
    },
    source_message_id: {
      type: DataTypes.STRING(36),
      allowNull: true,
      comment: '抽取来源消息 id',
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

  await queryInterface.addIndex('user_memories', ['tenant_id', 'user_id'], {
    name: 'idx_user_memories_tenant_user',
  });
  await queryInterface.addIndex('user_memories', ['tenant_id', 'created_at'], {
    name: 'idx_user_memories_tenant_created',
  });

  await queryInterface.sequelize.query(
    "ALTER TABLE user_memories COMMENT = '用户长期记忆（B4 长期记忆）'",
  );
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.dropTable('user_memories');
};
