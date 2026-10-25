import { DataTypes, type QueryInterface } from 'sequelize';
import type { MigrationFn } from 'umzug';
import { listColumns, tableExists } from './helpers/schema';

/**
 * 把 messages.tool_results 里「被重载的 data part」挪到新列 messages.parts
 *
 * ## 起因
 *
 * `messages.tool_results` 的 DDL 原意是「工具调用的输出」（Phase 2 才有工具）。
 * 但在本期它被**重载**成 `{ data_parts: [...] }`，用来装 AI SDK 的 data part
 * （引用片段 data-citations、阶段心跳 data-status）——
 * 否则刷新页面后历史回答的「来源」角标就丢了。
 *
 * B3 工具调用落地后，这一列会出现**两种形状**（真工具输出 vs data part），
 * 同一列混着两种语义，前端只能靠 key 猜 —— 这就是
 * `src/models/Message.ts` 的类注释和 AGENTS.md 点名要求先做这条迁移的原因。
 *
 * ## 做法
 *
 *  1. 加 `parts JSON` 列 —— 装 data part **数组**
 *  2. 回填：`tool_results.data_parts` → `parts`
 *  3. `tool_results` 清空 —— 留白给真正的工具调用输出
 *
 * ## 幂等
 *
 *  - 列已存在 → 跳过（回填部分可重复跑，幂等）
 *  - 表不存在 → 跳过
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  if (!(await tableExists(queryInterface, 'messages'))) {
    return;
  }

  const columns = await listColumns(queryInterface, 'messages');
  if (!columns.has('parts')) {
    await queryInterface.addColumn('messages', 'parts', {
      type: DataTypes.JSON,
      allowNull: true,
      comment: 'AI SDK 的 data part 数组（引用片段 / 阶段心跳 / 工具调用记录）',
    });
  }

  // 回填：只搬「确实是数组」的那些行
  await queryInterface.sequelize.query(
    "UPDATE messages SET parts = JSON_EXTRACT(tool_results, '$.data_parts') " +
      "WHERE tool_results IS NOT NULL " +
      "AND JSON_TYPE(JSON_EXTRACT(tool_results, '$.data_parts')) = 'ARRAY'",
  );

  // 搬完把 tool_results 清空 —— 语义还给「真正的工具调用输出」
  await queryInterface.sequelize.query(
    'UPDATE messages SET tool_results = NULL WHERE parts IS NOT NULL',
  );
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  if (!(await tableExists(queryInterface, 'messages'))) {
    return;
  }

  const columns = await listColumns(queryInterface, 'messages');
  if (!columns.has('parts')) {
    return;
  }

  // 搬回旧列（保住数据，不做丢数据的回滚）
  await queryInterface.sequelize.query(
    "UPDATE messages SET tool_results = JSON_OBJECT('data_parts', parts) WHERE parts IS NOT NULL",
  );

  await queryInterface.removeColumn('messages', 'parts');
};
