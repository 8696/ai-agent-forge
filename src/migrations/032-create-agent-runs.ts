import { DataTypes, type QueryInterface } from 'sequelize';
import type { MigrationFn } from 'umzug';
import { tableExists } from './helpers/schema';

/**
 * 多代理协作的两张表 —— B6（docs/12-b-需求-ai对话能力.md §B6）
 *
 * ## 为什么是两张表而不是塞进 session.metadata
 *
 * - `agent_runs` —— **一次多代理批次**（一个会话的一轮对话里，主 agent 派了几次活）
 * - `agent_steps` —— 批次里的**每一次子代理调用**
 *
 * 塞进 `sessions.metadata` 也能跑，但：
 *  1. metadata 每次对话都要读，多代理的产出（几个 KB）会拖慢每一轮
 *  2. metadata 是 JSON 列，没有独立索引，「查这个会话跑过哪些批次」只能全扫
 *  3. 共享状态会**越滚越大**（每个子代理的产出都进去）
 *
 * ## 共享状态（shared_state）
 *
 * B6 的验收要求「子代理之间通过共享状态协作，不靠主代理复述上下文」。
 * 实现：`agent_runs.shared_state` 存 `{ agent_key: 产出 }`，
 * 下一个子代理跑的时候，**引擎**把这份状态注入它的提示词 ——
 * 不是主代理转述，是引擎直接给的。
 *
 * ## 索引
 *
 * - idx_agent_runs_session (session_id) —— 「这个会话跑过哪些批次」
 * - idx_agent_runs_tenant_state (tenant_id, state) —— 租户隔离 + 状态筛选
 * - idx_agent_steps_run (run_id, created_at) —— 「这个批次里有哪些步骤」（调用树）
 * - idx_agent_steps_tenant (tenant_id) —— 租户隔离
 *
 * 幂等：表已存在就跳过。
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  if (await tableExists(queryInterface, 'agent_runs')) {
    return;
  }

  await queryInterface.createTable('agent_runs', {
    id: { type: DataTypes.STRING(36), primaryKey: true, allowNull: false },
    tenant_id: { type: DataTypes.STRING(36), allowNull: false, comment: '所属租户' },
    session_id: { type: DataTypes.STRING(36), allowNull: true, comment: '触发的会话' },
    user_id: { type: DataTypes.STRING(36), allowNull: true, comment: '触发者' },
    turn_id: {
      type: DataTypes.STRING(36),
      allowNull: true,
      comment: '触发这轮对话的 assistant 消息 id —— 用来定位「本轮」的批次',
    },
    question: { type: DataTypes.TEXT, allowNull: false, comment: '触发这次多代理的原始问题' },
    state: {
      type: DataTypes.ENUM('running', 'completed', 'failed'),
      allowNull: false,
      defaultValue: 'running',
      comment: '批次状态',
    },
    shared_state: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: '共享状态：{ agent_key: 产出 }（子代理之间靠它协作）',
    },
    result: { type: DataTypes.JSON, allowNull: true, comment: '最终结果' },
    created_at: {
      type: DataTypes.DATE(6),
      allowNull: false,
      defaultValue: queryInterface.sequelize.literal('CURRENT_TIMESTAMP(6)'),
    },
    updated_at: {
      type: DataTypes.DATE(6),
      allowNull: false,
      defaultValue: queryInterface.sequelize.literal('CURRENT_TIMESTAMP(6)'),
    },
  });

  await queryInterface.createTable('agent_steps', {
    id: { type: DataTypes.STRING(36), primaryKey: true, allowNull: false },
    tenant_id: { type: DataTypes.STRING(36), allowNull: false, comment: '所属租户' },
    run_id: { type: DataTypes.STRING(36), allowNull: false, comment: '所属批次' },
    agent: { type: DataTypes.STRING(64), allowNull: false, comment: '子代理角色 key' },
    task: { type: DataTypes.TEXT, allowNull: false, comment: '子任务描述' },
    output: { type: DataTypes.JSON, allowNull: true, comment: '子代理产出' },
    state: {
      type: DataTypes.ENUM('ok', 'failed'),
      allowNull: false,
      defaultValue: 'ok',
      comment: '这一步的结果',
    },
    error: { type: DataTypes.STRING(1000), allowNull: true, comment: '失败原因' },
    span_id: {
      type: DataTypes.STRING(36),
      allowNull: true,
      comment: '关联的 trace span（调用树靠它）',
    },
    created_at: {
      type: DataTypes.DATE(6),
      allowNull: false,
      defaultValue: queryInterface.sequelize.literal('CURRENT_TIMESTAMP(6)'),
    },
  });

  await queryInterface.addIndex('agent_runs', ['session_id'], { name: 'idx_agent_runs_session' });
  await queryInterface.addIndex('agent_runs', ['tenant_id', 'turn_id'], {
    name: 'idx_agent_runs_tenant_turn',
  });
  await queryInterface.addIndex('agent_runs', ['tenant_id', 'state'], {
    name: 'idx_agent_runs_tenant_state',
  });
  await queryInterface.addIndex('agent_steps', ['run_id', 'created_at'], {
    name: 'idx_agent_steps_run',
  });
  await queryInterface.addIndex('agent_steps', ['tenant_id'], { name: 'idx_agent_steps_tenant' });

  await queryInterface.sequelize.query(
    "ALTER TABLE agent_runs COMMENT = '多代理批次（B6 多代理协作）'",
  );
  await queryInterface.sequelize.query(
    "ALTER TABLE agent_steps COMMENT = '多代理的每一步（B6 · 调用树）'",
  );
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.dropTable('agent_steps');
  await queryInterface.dropTable('agent_runs');
};
