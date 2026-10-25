import { DataTypes, type QueryInterface } from 'sequelize';
import type { MigrationFn } from 'umzug';
import { tableExists } from './helpers/schema';

/**
 * 工具调用流水表 —— B3 工具调用（docs/12-b-需求-ai对话能力.md §B3）
 *
 * 一行 = 一次工具调用（含「模型给了什么参数」和「工具返回了什么」）。
 * 用途：后台的「工具调用记录」页 —— 按时间 / 工具 / 状态筛，翻页看每次调用的入参和返回。
 *
 * 索引：
 *  - idx_tool_call_logs_tenant_created (tenant_id, created_at) —— 默认列表（按时间倒序）
 *  - idx_tool_call_logs_tenant_tool (tenant_id, tool_name, created_at) —— 「只看某个工具」
 *  - idx_tool_call_logs_session (session_id) —— 「只看某个会话」
 *
 * 不加外键（跟 cost_logs / traces 一致）：外键只会拖慢写入。
 *
 * 幂等：表已存在就跳过。
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  if (await tableExists(queryInterface, 'tool_call_logs')) {
    return;
  }

  await queryInterface.createTable('tool_call_logs', {
    id: {
      type: DataTypes.STRING(36),
      primaryKey: true,
      allowNull: false,
      comment: '工具调用 id（nanoid 21）',
    },
    tenant_id: {
      type: DataTypes.STRING(36),
      allowNull: false,
      comment: '所属租户',
    },
    user_id: {
      type: DataTypes.STRING(36),
      allowNull: true,
      comment: '触发调用的用户（匿名挂件 / 对外 API 为空）',
    },
    session_id: {
      type: DataTypes.STRING(36),
      allowNull: true,
      comment: '所属会话',
    },
    message_id: {
      type: DataTypes.STRING(36),
      allowNull: true,
      comment: '关联的 assistant 消息 id',
    },
    tool_call_id: {
      type: DataTypes.STRING(64),
      allowNull: false,
      comment: 'SDK 分配的调用 id',
    },
    tool_name: {
      type: DataTypes.STRING(100),
      allowNull: false,
      comment: '注册名（模型调用的就是这个名字）',
    },
    builtin: {
      type: DataTypes.STRING(64),
      allowNull: true,
      comment: '内置实现 key',
    },
    status: {
      type: DataTypes.ENUM('ok', 'error', 'timeout', 'awaiting_confirmation'),
      allowNull: false,
      defaultValue: 'ok',
      comment: 'ok=成功 / error=抛错 / timeout=超时 / awaiting_confirmation=待用户确认（未执行）',
    },
    args: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: '请求参数（模型给的入参）',
    },
    output: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: '响应参数（工具的返回值）',
    },
    error: {
      type: DataTypes.STRING(1000),
      allowNull: true,
      comment: '失败原因（成功时为空）',
    },
    duration_ms: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: '耗时（毫秒）',
    },
    trace_id: {
      type: DataTypes.STRING(36),
      allowNull: true,
      comment: '关联的 trace id',
    },
    created_at: {
      type: DataTypes.DATE(6),
      allowNull: false,
      defaultValue: queryInterface.sequelize.literal('CURRENT_TIMESTAMP(6)'),
      comment: '调用时间',
    },
  });

  await queryInterface.addIndex('tool_call_logs', ['tenant_id', 'created_at'], {
    name: 'idx_tool_call_logs_tenant_created',
  });
  await queryInterface.addIndex('tool_call_logs', ['tenant_id', 'tool_name', 'created_at'], {
    name: 'idx_tool_call_logs_tenant_tool',
  });
  await queryInterface.addIndex('tool_call_logs', ['session_id'], {
    name: 'idx_tool_call_logs_session',
  });

  await queryInterface.sequelize.query(
    "ALTER TABLE tool_call_logs COMMENT = '工具调用流水（B3 工具调用）'",
  );
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.dropTable('tool_call_logs');
};
