import { DataTypes, QueryTypes, type QueryInterface } from 'sequelize';
import type { MigrationFn } from 'umzug';
import { listColumns } from './helpers/schema';

/**
 * 给 tenant_models.usage_scope 加第三个取值 'summary' —— 会话摘要模型可独立配置
 *
 * 起因（docs/12-b §B1 摘要压缩）：
 * 摘要压缩是**独立的一次 LLM 调用**（每轮对话最多一次），跟对话模型一样，
 * 租户用推理型模型时思考 token 全额算输出 token。
 * 不给它独立 scope 的话，租户**没有任何办法**把摘要切到便宜模型 ——
 * 跟 B4 记忆抽取当初一模一样的坑（那时靠 migration 018 补的 memory scope）。
 *
 * ## 语义
 *  - chat    = 对话模型（默认）
 *  - memory  = 记忆抽取模型（migration 018 加的）
 *  - summary = 会话摘要模型。没配时摘要**回落到对话模型**（不配也能用）。
 *
 * 不变式不变：每租户**每个 scope** 恰一条 is_active。
 * 存量数据全在 chat / memory 两个取值里，扩 ENUM 不动它们。
 *
 * ## 幂等
 *  - 列不存在（migration 018 还没跑）→ 直接跳过，018 会建出带 summary 的列
 *  - 列已经有 'summary' → 跳过
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  const columns = await listColumns(queryInterface, 'tenant_models');
  if (!columns.has('usage_scope')) {
    // migration 018 还没跑 —— 它建列时直接带上 summary，这里不用管
    return;
  }

  const rows = await queryInterface.sequelize.query<{ COLUMN_TYPE: string }>(
    'SELECT COLUMN_TYPE FROM information_schema.COLUMNS ' +
      'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    { replacements: ['tenant_models', 'usage_scope'], type: QueryTypes.SELECT },
  );
  const current = rows[0]?.COLUMN_TYPE ?? '';
  if (current.includes("'summary'")) {
    return;
  }

  await queryInterface.changeColumn('tenant_models', 'usage_scope', {
    type: DataTypes.ENUM('chat', 'memory', 'summary'),
    allowNull: false,
    defaultValue: 'chat',
    comment:
      '用途：chat=对话模型 / memory=记忆抽取模型 / summary=会话摘要模型' +
      '（memory / summary 没配时回落到 chat）',
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  const columns = await listColumns(queryInterface, 'tenant_models');
  if (!columns.has('usage_scope')) {
    return;
  }

  // 摘要是可选能力，回退时先摘掉用 summary 的行 —— 不然 ENUM 收窄会失败
  await queryInterface.sequelize.query(
    "DELETE FROM tenant_models WHERE usage_scope = 'summary'",
  );

  await queryInterface.changeColumn('tenant_models', 'usage_scope', {
    type: DataTypes.ENUM('chat', 'memory'),
    allowNull: false,
    defaultValue: 'chat',
    comment: '用途：chat=对话模型 / memory=记忆抽取模型（没配 memory 时抽取回落到 chat）',
  });
};
