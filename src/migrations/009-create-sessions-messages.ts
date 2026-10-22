import { DataTypes, QueryTypes, type DataType, type QueryInterface } from 'sequelize';
import type { MigrationFn } from 'umzug';
import { tableExists, listColumns } from './helpers/schema';

/**
 * 对话会话表 + 聊天消息表 —— 详见 docs/05-a-数据模型-mysql.md §对话会话表 / §消息表
 *
 * 设计要点：
 *  - 两表都是 B1（多轮对话 + LLM 流式）落地的产物，DB 是对话历史的真理来源
 *  - sessions.channel 本期只有 'web' 在用（customer 登录后的前台聊天页）；
 *    'widget' 留给下一轮的公开挂件（E1，user_id 为 NULL 表示匿名），
 *    'email' / 'api' 是 docs/05-a 原定的预留值，本期无入口
 *  - sessions.summary 预留给「真摘要压缩」：本期恒为 NULL，超长对话靠 token 预算截断
 *  - messages.session_id / tenant_id 都带 CASCADE：删会话连带删消息，不留孤儿
 *  - messages.status 的 streaming 态：流式回答开始时先建行（content 为空），
 *    流结束后回填正文 + usage 并置 complete；中途断开置 cancelled，保留已生成的部分正文
 *  - 两表都 timestamps: false —— DDL 里没有 updated_at，对话记录不做原地修改
 *    （唯一会改的是 assistant 消息的流式回填和 feedback，见 src/services/chat.ts）
 *
 * ⚠️ **为什么是「收敛」而不是纯建表**（同 008-converge-documents-schema 的理由）：
 *  更早的 Step 6 实现建过同名的 sessions / messages 表（迁移记录 008-create-sessions /
 *  009-create-messages 仍在 sequelize_meta 里），那两张表缺 `channel` 的 'web' 枚举值。
 *  Sequelize 的 createTable 会生成 `CREATE TABLE IF NOT EXISTS`，表在的时候**静默跳过**，
 *  后续的 addIndex 就会撞「Duplicate key name」。所以这里逐项判断再动手：
 *   - 表不存在 → 建全
 *   - 表存在   → 只补缺列、只补缺的索引，并无条件把 channel 收敛到含 'web' 的定义
 */

/** 当前 schema 要求存在、但老版本可能缺的列 */
const DESIRED_COLUMNS: Record<
  'sessions' | 'messages',
  Array<{ name: string; definition: { type: DataType; allowNull: boolean; comment: string } }>
> = {
  sessions: [
    { name: 'summary', definition: { type: DataTypes.TEXT, allowNull: true, comment: '摘要压缩后的早期对话内容' } },
    { name: 'metadata', definition: { type: DataTypes.JSON, allowNull: true, comment: '渠道 / 来源 / 客户端信息' } },
    { name: 'ended_at', definition: { type: DataTypes.DATE(6), allowNull: true, comment: '结束时间（NULL 表示进行中）' } },
  ],
  messages: [
    {
      name: 'thinking_content',
      definition: { type: DataTypes.TEXT('medium'), allowNull: true, comment: '思考模式的推理过程' },
    },
    { name: 'tool_calls', definition: { type: DataTypes.JSON, allowNull: true, comment: '工具调用的输入' } },
    { name: 'tool_results', definition: { type: DataTypes.JSON, allowNull: true, comment: '工具调用的输出' } },
    { name: 'usage', definition: { type: DataTypes.JSON, allowNull: true, comment: 'LLM 返回的真实 token 数' } },
    { name: 'feedback', definition: { type: DataTypes.TINYINT, allowNull: true, comment: '1=点赞 / -1=点踩 / NULL=无' } },
    {
      name: 'feedback_text',
      definition: { type: DataTypes.STRING(1000), allowNull: true, comment: '反馈文本' },
    },
    { name: 'feedback_at', definition: { type: DataTypes.DATE(6), allowNull: true, comment: '反馈时间' } },
    { name: 'trace_id', definition: { type: DataTypes.STRING(36), allowNull: true, comment: '关联到 traces（D2）' } },
  ],
};

/** channel 的目标定义（含 'web'）—— 老表的 ENUM 里没有这个值 */
const CHANNEL_COLUMN = {
  type: DataTypes.ENUM('web', 'widget', 'email', 'api'),
  allowNull: false,
  comment: '接入渠道',
};

export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  if (!(await tableExists(queryInterface, 'sessions'))) {
    await createSessions(queryInterface);
  } else {
    await convergeTable(queryInterface, 'sessions');
  }

  if (!(await tableExists(queryInterface, 'messages'))) {
    await createMessages(queryInterface);
  } else {
    await convergeTable(queryInterface, 'messages');
  }

  // channel 枚举单独收敛（新建的表天然含 'web'，changeColumn 是幂等的）
  await ensureChannelEnum(queryInterface);
};

async function createSessions(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.createTable('sessions', {
    id: { type: DataTypes.STRING(36), primaryKey: true, comment: '会话 ID（nanoid(21)）' },
    tenant_id: {
      type: DataTypes.STRING(36),
      allowNull: false,
      comment: '所属租户',
      references: { model: 'tenants', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    user_id: { type: DataTypes.STRING(36), allowNull: true, comment: '前台用户 ID；匿名访问为 NULL' },
    channel: { ...CHANNEL_COLUMN, defaultValue: 'web' },
    status: {
      type: DataTypes.ENUM('active', 'closed', 'transferred'),
      allowNull: false,
      defaultValue: 'active',
      comment: '会话状态',
    },
    title: {
      type: DataTypes.STRING(200),
      allowNull: true,
      comment: '首条用户消息的前 20 字（自动生成，用户可重命名）',
    },
    summary: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: '摘要压缩后的早期对话内容（真摘要压缩下一轮落地，本期恒为 NULL）',
    },
    metadata: { type: DataTypes.JSON, allowNull: true, comment: '渠道 / 来源 / 客户端信息' },
    started_at: {
      type: DataTypes.DATE(6),
      allowNull: false,
      defaultValue: queryInterface.sequelize.literal('CURRENT_TIMESTAMP(6)'),
      comment: '开始时间',
    },
    ended_at: { type: DataTypes.DATE(6), allowNull: true, comment: '结束时间（NULL 表示进行中）' },
  });

  await addIndexIfMissing(queryInterface, 'sessions', ['tenant_id', 'started_at'], 'idx_sessions_tenant_started');
  await addIndexIfMissing(queryInterface, 'sessions', ['user_id'], 'idx_sessions_user');
  await queryInterface.sequelize.query("ALTER TABLE sessions COMMENT = '对话会话表'");
}

async function createMessages(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.createTable('messages', {
    id: { type: DataTypes.STRING(36), primaryKey: true, comment: '消息 ID（nanoid(21)）' },
    session_id: {
      type: DataTypes.STRING(36),
      allowNull: false,
      comment: '所属会话',
      references: { model: 'sessions', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    tenant_id: {
      type: DataTypes.STRING(36),
      allowNull: false,
      comment: '冗余存（方便按租户统计与成本汇总）',
      references: { model: 'tenants', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    role: {
      type: DataTypes.ENUM('user', 'assistant', 'system', 'tool'),
      allowNull: false,
      comment: '消息角色',
    },
    content: { type: DataTypes.TEXT('medium'), allowNull: true, comment: '消息正文（Markdown / 纯文本）' },
    thinking_content: {
      type: DataTypes.TEXT('medium'),
      allowNull: true,
      comment: '思考模式的推理过程（与 content 分离）',
    },
    tool_calls: { type: DataTypes.JSON, allowNull: true, comment: '工具调用的输入（Phase 2 才有值）' },
    tool_results: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: '工具调用的输出；本期重载为 AI SDK 的 data part（见 MessageToolResults）',
    },
    usage: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: 'LLM 返回的真实 token 数：{ input_tokens, output_tokens, cache_read_tokens }',
    },
    status: {
      type: DataTypes.ENUM('streaming', 'complete', 'failed', 'cancelled'),
      allowNull: false,
      defaultValue: 'complete',
      comment: '消息状态（流式用）',
    },
    feedback: { type: DataTypes.TINYINT, allowNull: true, comment: '用户反馈：1=点赞 / -1=点踩 / NULL=无' },
    feedback_text: { type: DataTypes.STRING(1000), allowNull: true, comment: '反馈文本（"答错 / 答偏 / 其他"）' },
    feedback_at: { type: DataTypes.DATE(6), allowNull: true, comment: '反馈时间' },
    trace_id: { type: DataTypes.STRING(36), allowNull: true, comment: '关联到 traces（D2 观测，本期留空）' },
    created_at: {
      type: DataTypes.DATE(6),
      allowNull: false,
      defaultValue: queryInterface.sequelize.literal('CURRENT_TIMESTAMP(6)'),
      comment: '消息时间',
    },
  });

  await addIndexIfMissing(queryInterface, 'messages', ['session_id', 'created_at'], 'idx_messages_session_created');
  await addIndexIfMissing(queryInterface, 'messages', ['tenant_id', 'created_at'], 'idx_messages_tenant_created');
  await addIndexIfMissing(queryInterface, 'messages', ['trace_id'], 'idx_messages_trace');
  await queryInterface.sequelize.query("ALTER TABLE messages COMMENT = '聊天消息表'");
}

/** 老表收敛：补缺列 + 补缺索引 */
async function convergeTable(queryInterface: QueryInterface, table: 'sessions' | 'messages'): Promise<void> {
  const existing = await listColumns(queryInterface, table);
  for (const column of DESIRED_COLUMNS[table]) {
    if (existing.has(column.name)) {
      continue;
    }
    await queryInterface.addColumn(table, column.name, column.definition);
  }

  const wanted =
    table === 'sessions'
      ? [
          [['tenant_id', 'started_at'], 'idx_sessions_tenant_started'],
          [['user_id'], 'idx_sessions_user'],
        ] as Array<[string[], string]>
      : [
          [['session_id', 'created_at'], 'idx_messages_session_created'],
          [['tenant_id', 'created_at'], 'idx_messages_tenant_created'],
          [['trace_id'], 'idx_messages_trace'],
        ] as Array<[string[], string]>;
  for (const [columns, name] of wanted) {
    await addIndexIfMissing(queryInterface, table, columns, name);
  }
}

/**
 * 把 channel 的 ENUM 收敛到含 'web' 的定义。
 *
 * 单独一条迁移是因为它**不是「缺列」而是「枚举值少一个」** ——
 * information_schema 里看列是存在的，逐列比对的写法发现不了这种差异，
 * 而老库的 channel 里没有 'web' 会让每一次 INSERT 都报
 * `Data truncated for column 'channel'`。
 *
 * MODIFY 而不是 ADD：MySQL 不支持直接给 ENUM 追加值。
 */
async function ensureChannelEnum(queryInterface: QueryInterface): Promise<void> {
  const rows = await queryInterface.sequelize.query<{ COLUMN_TYPE: string }>(
    'SELECT COLUMN_TYPE FROM information_schema.COLUMNS ' +
      'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    { replacements: ['sessions', 'channel'], type: QueryTypes.SELECT },
  );
  const current = rows[0]?.COLUMN_TYPE ?? '';
  if (current.includes("'web'")) {
    return;
  }
  await queryInterface.changeColumn('sessions', 'channel', {
    ...CHANNEL_COLUMN,
    defaultValue: 'web',
  });
}

async function addIndexIfMissing(
  queryInterface: QueryInterface,
  table: string,
  columns: string[],
  name: string,
): Promise<void> {
  const rows = await queryInterface.sequelize.query<{ INDEX_NAME: string }>(
    'SELECT INDEX_NAME FROM information_schema.STATISTICS ' +
      'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?',
    { replacements: [table, name], type: QueryTypes.SELECT },
  );
  if (rows.length > 0) {
    return;
  }
  await queryInterface.addIndex(table, columns, { name });
}

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  // 只在「本迁移建的表」上回滚。判据：表的 channel 枚举里有 'web'，
  // 且 sequelize_meta 里没有更早的 008-create-sessions —— 后者无法在迁移里查，
  // 所以这里采取保守策略：只收敛 ENUM 回原值，不删表。
  //
  // 删表会连带删掉用户的对话历史，迁移回滚不该做这件事；
  // 真要清空走 `yarn migrate:undo` + 备份恢复（见 docs/13-扩展指南 §13.8）。
  if (await tableExists(queryInterface, 'sessions')) {
    await queryInterface.changeColumn('sessions', 'channel', {
      type: DataTypes.ENUM('widget', 'email', 'api'),
      allowNull: false,
      defaultValue: 'widget',
      comment: '接入渠道',
    });
  }
};