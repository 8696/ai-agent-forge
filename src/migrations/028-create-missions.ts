import { DataTypes, type QueryInterface } from 'sequelize';
import type { MigrationFn } from 'umzug';
import { tableExists } from './helpers/schema';

/**
 * 任务表（missions）—— B5 状态机工作流（docs/12-b-需求-ai对话能力.md §B5 / §B5.1）
 *
 * 一行 = **一次业务流程任务**。它记的是「这件事走到哪一步了」，
 * 而不是「用户批准了哪个工具」（后者是 `sessions.metadata.approved_tool_calls` 的活）。
 *
 * ## 为什么状态落在 DB 而不是内存
 *
 * - 断点恢复：进程在 `running` 中途被 kill，重启后能从这张表读到未完成任务并续跑
 * - 跨轮 / 跨会话：用户隔天回来接着办，任务还在
 * - 可观测：后台能查「有多少任务卡在等确认」
 *
 * 内存态做不到第一条 —— 内存随进程一起没了。
 *
 * ## 列
 *
 *  - `type` —— 流程类型（`refund_request` / `modify_address` / `after_sale_ticket`），
 *    对应 `src/workflows/types.ts` 里 `WORKFLOWS` 常量的流程定义
 *  - `state` —— 状态机，6 个取值（见下）
 *  - `current_step` —— 当前节点（流程定义的节点 id），断点恢复靠它知道从哪继续
 *  - `approval_key` —— 用户批准的那次工具调用（`工具名:入参指纹`），
 *    闸门靠它把「用户点过确认」和「这次调用」对上
 *  - `context` —— 流程收集到的中间数据（订单信息、优惠信息…），JSON
 *  - `result` —— 流程的最终结果，JSON
 *  - `expires_at` —— 超时时间（等确认期间过期 → 转 `cancelled`）
 *
 * ## 状态机
 *
 *   (无) → pending → awaiting_confirmation ⇄ running → completed
 *                    ↘ cancelled                    ↘ failed
 *
 * ## 索引
 *
 *  - idx_missions_tenant_state (tenant_id, state) —— 租户隔离 + 状态筛选
 *  - idx_missions_state_updated (state, updated_at) —— 「捞所有待处理的」
 *  - idx_missions_session (session_id) —— 「这个会话有哪些任务」
 *  - idx_missions_tenant_approval (tenant_id, approval_key) —— 批准/拒绝时定位
 *  - idx_missions_tenant_user (tenant_id, user_id, state) —— 「这个用户还有哪些任务没结束」
 *
 * ⚠️ **不加外键**（跟 cost_logs / traces / tool_call_logs 一致）：外键只拖慢写入。
 *
 * 幂等：表已存在就跳过。
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  if (await tableExists(queryInterface, 'missions')) {
    return;
  }

  await queryInterface.createTable('missions', {
    id: {
      type: DataTypes.STRING(36),
      primaryKey: true,
      allowNull: false,
      comment: '任务 id（nanoid 21）',
    },
    tenant_id: {
      type: DataTypes.STRING(36),
      allowNull: false,
      comment: '所属租户',
    },
    session_id: {
      type: DataTypes.STRING(36),
      allowNull: true,
      comment: '触发的会话（后台任务为空）',
    },
    user_id: {
      type: DataTypes.STRING(36),
      allowNull: true,
      comment: '触发者（匿名挂件 / 对外 API 为空）',
    },
    type: {
      type: DataTypes.STRING(100),
      allowNull: false,
      comment: '流程类型（refund_request / modify_address / after_sale_ticket）',
    },
    state: {
      type: DataTypes.ENUM(
        'pending',
        'running',
        'awaiting_confirmation',
        'completed',
        'failed',
        'cancelled',
      ),
      allowNull: false,
      defaultValue: 'pending',
      comment: '任务状态机',
    },
    is_sensitive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment: '是否含敏感操作（true 时要用户点头）',
    },
    current_step: {
      type: DataTypes.STRING(100),
      allowNull: true,
      comment: '当前节点 id（断点恢复靠它知道从哪继续）',
    },
    approval_key: {
      type: DataTypes.STRING(255),
      allowNull: true,
      comment: '用户批准的那次工具调用（工具名:入参指纹）',
    },
    context: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: '流程收集到的中间数据（订单信息、优惠信息…）',
    },
    result: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: '流程最终结果',
    },
    expires_at: {
      type: DataTypes.DATE(6),
      allowNull: true,
      comment: '超时时间（过期 → cancelled）',
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

  await queryInterface.addIndex('missions', ['tenant_id', 'state'], {
    name: 'idx_missions_tenant_state',
  });
  await queryInterface.addIndex('missions', ['state', 'updated_at'], {
    name: 'idx_missions_state_updated',
  });
  await queryInterface.addIndex('missions', ['session_id'], {
    name: 'idx_missions_session',
  });
  await queryInterface.addIndex('missions', ['tenant_id', 'approval_key'], {
    name: 'idx_missions_tenant_approval',
  });
  await queryInterface.addIndex('missions', ['tenant_id', 'user_id', 'state'], {
    name: 'idx_missions_tenant_user',
  });

  await queryInterface.sequelize.query(
    "ALTER TABLE missions COMMENT = '任务表（B5 状态机工作流）'",
  );
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.dropTable('missions');
};
