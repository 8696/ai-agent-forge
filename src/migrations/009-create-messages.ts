import { DataTypes, type QueryInterface } from 'sequelize';
import type { MigrationFn } from 'umzug';

/**
 * Step 7 · 多轮对话 —— 建 `messages` 表
 * 详见 docs/05-a-数据模型-mysql.md §5.1 + docs/15-开发进度计划.md §Step 7 + docs/16-b §B1
 *
 * 关键设计：
 *  - `thinking_content` 与 `content` 分离：思考模式推理过程独立存储，UI 上折叠
 *  - `role` ENUM 含 'tool'：工具调用结果也入消息历史（Vercel AI SDK tool calls）
 *  - `status` 'streaming' / 'complete' / 'failed' / 'cancelled'：流式用；Step 7 chat-stream 先写
 *    'streaming'，结束 / 出错时回填
 *  - `usage` JSON：{ input_tokens, output_tokens, cache_read_tokens }（Anthropic API 返回）
 *  - `trace_id` 关联到 Step 11 的 traces（先建字段，Step 11 写 span 时回填）
 *  - `feedback` 1 / -1 / NULL：用户反馈，Step 8 前端用
 *  - `feedback_text` + `feedback_at`：可选反馈文本 + 时间
 *  - 索引 idx_session：会话内按时间翻页（最常见查询）
 *  - 索引 idx_tenant：按租户统计（消息量 / token 用量）
 *  - 索引 idx_trace：trace 详情里反向查消息（Step 11 落地时用）
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.createTable('messages', {
    id: {
      type: DataTypes.STRING(36),
      primaryKey: true,
      comment: 'UUID',
    },
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
      comment: '冗余存（方便按租户统计）',
    },
    role: {
      type: DataTypes.ENUM('user', 'assistant', 'system', 'tool'),
      allowNull: false,
      comment: '消息角色',
    },
    content: {
      type: DataTypes.TEXT('medium'),
      allowNull: true,
      comment: '消息正文（Markdown / 纯文本）',
    },
    thinking_content: {
      type: DataTypes.TEXT('medium'),
      allowNull: true,
      comment: '思考模式推理过程（与 content 分离）',
    },
    tool_calls: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: '工具调用的输入（role=tool 时为空）',
    },
    tool_results: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: '工具调用的输出',
    },
    usage: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: '{ input_tokens, output_tokens, cache_read_tokens }',
    },
    status: {
      type: DataTypes.ENUM('streaming', 'complete', 'failed', 'cancelled'),
      allowNull: false,
      defaultValue: 'complete',
      comment: '消息状态（流式用）',
    },
    feedback: {
      type: DataTypes.TINYINT,
      allowNull: true,
      comment: '用户反馈：1=点赞 / -1=点踩 / NULL=无',
    },
    feedback_text: {
      type: DataTypes.STRING(1000),
      allowNull: true,
      comment: '反馈文本（"答错 / 答偏 / 其他"）',
    },
    feedback_at: {
      type: DataTypes.DATE(6),
      allowNull: true,
      comment: '反馈时间',
    },
    trace_id: {
      type: DataTypes.STRING(36),
      allowNull: true,
      comment: '关联到 traces（用于在 Trace 详情里看到这条消息）',
    },
    created_at: {
      type: DataTypes.DATE(6),
      allowNull: false,
      defaultValue: queryInterface.sequelize.literal('CURRENT_TIMESTAMP(6)'),
      comment: '消息时间',
    },
  });

  await queryInterface.addIndex('messages', ['session_id', 'created_at'], {
    name: 'idx_messages_session_created',
  });
  await queryInterface.addIndex('messages',['tenant_id', 'created_at'], {
    name: 'idx_messages_tenant_created',
  });
  await queryInterface.addIndex('messages',['trace_id'], {
    name: 'idx_messages_trace',
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.dropTable('messages');
};
