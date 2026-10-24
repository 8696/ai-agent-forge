import { DataTypes, type QueryInterface } from 'sequelize';
import type { MigrationFn } from 'umzug';

/**
 * Trace / Span 表 —— D2（docs/12-d-需求-运维稳定.md §D2）
 *
 * ## 为什么是自建的两张表，而不是上 OpenTelemetry
 * 需求文档明确写了「**不上 OpenTelemetry 完整链路**（简化）」。
 * OTel 的价值在于跨语言 / 跨进程的链路追踪；这个平台只有 Node 一个进程、
 * 一条对话就是一条链路，自己两张表 + 一个写入器就够，依赖和运维成本低一个量级。
 *
 * ## 两层的分工
 *  - `traces`  = 一次**对话 / 请求**（用户视角的一次交互）
 *  - `spans`   = 这次交互里的**一步**（路由 / 检索 / 调模型 / 记账 / 安全审核）
 *
 * ## 为什么不加外键
 * 跟 audit_logs / cost_logs 一致：跨子系统查询多，外键会拖累写入；
 * span 挂在哪条 trace 上由应用层保证（trace 结束时同一个事务里一起写）。
 *
 * 索引：
 *  - (tenant_id, started_at) —— 列表页主查询（按时间倒序 + 租户隔离）
 *  - (tenant_id, status, started_at) —— 筛选「失败 trace」
 *  - (trace_id) —— 详情页拉 span
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.createTable('traces', {
    id: {
      type: DataTypes.STRING(36),
      primaryKey: true,
      allowNull: false,
      comment: 'trace id（nanoid 21）',
    },
    tenant_id: {
      type: DataTypes.STRING(36),
      allowNull: false,
      comment: '所属租户',
    },
    user_id: {
      type: DataTypes.STRING(36),
      allowNull: true,
      comment: '触发用户（系统内部调用可空）',
    },
    session_id: {
      type: DataTypes.STRING(36),
      allowNull: true,
      comment: '所属会话',
    },
    name: {
      type: DataTypes.STRING(100),
      allowNull: false,
      comment: 'trace 名（如 chat.message）',
    },
    kind: {
      type: DataTypes.STRING(32),
      allowNull: false,
      defaultValue: 'chat',
      comment: 'trace 类型：chat / api / evaluation',
    },
    status: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: 'success',
      comment: 'success / error',
    },
    channel: {
      type: DataTypes.STRING(32),
      allowNull: true,
      comment: '接入渠道（web / widget / api）',
    },
    provider: {
      type: DataTypes.STRING(32),
      allowNull: true,
      comment: 'LLM provider',
    },
    model: {
      type: DataTypes.STRING(100),
      allowNull: true,
      comment: '实际使用的模型 id',
    },
    input_tokens: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: '输入 token',
    },
    output_tokens: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: '输出 token',
    },
    cache_read_tokens: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: '缓存读取 token',
    },
    cache_write_tokens: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: '缓存写入 token',
    },
    total_tokens: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: '合计 token',
    },
    cost: {
      type: DataTypes.DECIMAL(12, 6),
      allowNull: false,
      defaultValue: 0,
      comment: '估算花费（USD）',
    },
    duration_ms: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: '总耗时（毫秒）',
    },
    error_message: {
      type: DataTypes.STRING(500),
      allowNull: true,
      comment: '失败原因（摘要，不记堆栈）',
    },
    metadata: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: '附加信息（JSON）',
    },
    started_at: {
      type: DataTypes.DATE(6),
      allowNull: false,
      comment: '开始时间',
    },
    ended_at: {
      type: DataTypes.DATE(6),
      allowNull: true,
      comment: '结束时间',
    },
    created_at: {
      type: DataTypes.DATE(6),
      allowNull: false,
      defaultValue: queryInterface.sequelize.literal('CURRENT_TIMESTAMP(6)'),
      comment: '入库时间',
    },
  });

  await queryInterface.addIndex('traces', ['tenant_id', 'started_at'], {
    name: 'idx_traces_tenant_started',
  });
  await queryInterface.addIndex('traces', ['tenant_id', 'status', 'started_at'], {
    name: 'idx_traces_tenant_status_started',
  });
  await queryInterface.addIndex('traces', ['session_id'], { name: 'idx_traces_session' });
  await queryInterface.addIndex('traces', ['user_id'], { name: 'idx_traces_user' });

  await queryInterface.createTable('spans', {
    id: {
      type: DataTypes.STRING(36),
      primaryKey: true,
      allowNull: false,
      comment: 'span id（nanoid 21）',
    },
    trace_id: {
      type: DataTypes.STRING(36),
      allowNull: false,
      comment: '所属 trace',
    },
    tenant_id: {
      type: DataTypes.STRING(36),
      allowNull: false,
      comment: '所属租户（冗余一份，方便按租户直接查）',
    },
    parent_span_id: {
      type: DataTypes.STRING(36),
      allowNull: true,
      comment: '父 span（null = 直接挂在 trace 下）',
    },
    name: {
      type: DataTypes.STRING(100),
      allowNull: false,
      comment: 'span 名（如 retrieval.search）',
    },
    kind: {
      type: DataTypes.STRING(32),
      allowNull: false,
      defaultValue: 'step',
      comment: 'http / retrieval / llm / guard / cost / storage',
    },
    status: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: 'success',
      comment: 'success / error',
    },
    duration_ms: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: '耗时（毫秒）',
    },
    input: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: '入参摘要（JSON）',
    },
    output: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: '出参摘要（JSON）',
    },
    error_message: {
      type: DataTypes.STRING(500),
      allowNull: true,
      comment: '失败原因（摘要）',
    },
    started_at: {
      type: DataTypes.DATE(6),
      allowNull: false,
      comment: '开始时间',
    },
    ended_at: {
      type: DataTypes.DATE(6),
      allowNull: true,
      comment: '结束时间',
    },
    created_at: {
      type: DataTypes.DATE(6),
      allowNull: false,
      defaultValue: queryInterface.sequelize.literal('CURRENT_TIMESTAMP(6)'),
      comment: '入库时间',
    },
  });

  await queryInterface.addIndex('spans', ['trace_id'], { name: 'idx_spans_trace' });
  await queryInterface.addIndex('spans', ['tenant_id', 'started_at'], {
    name: 'idx_spans_tenant_started',
  });

  await queryInterface.sequelize.query(
    "ALTER TABLE traces COMMENT = '一次对话/请求的调用链（D2 观测）'",
  );
  await queryInterface.sequelize.query(
    "ALTER TABLE spans COMMENT = '调用链里的一步（D2 观测）'",
  );
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.dropTable('spans');
  await queryInterface.dropTable('traces');
};
