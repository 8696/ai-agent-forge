import { DataTypes, type QueryInterface } from 'sequelize';
import type { MigrationFn } from 'umzug';
import { listColumns } from './helpers/schema';

/**
 * 给 tenant_models 加 usage_scope —— 记忆抽取模型可独立配置
 *
 * 起因（docs/12-b §B4 已知边界之一）：
 * 记忆抽取用的是**对话那个模型**（src/services/memory.ts 的 extractAndApplyMemories
 * 直接吃对话链路解析出来的 llm 配置）。租户用推理型模型时，思考 token 全额算输出 token，
 * 一次抽取实测要 2000+ token，而租户**没有任何办法**把抽取切到便宜模型 ——
 * 这是 B4 里唯一一项 `.env` 和通用配置页都调不动的成本。
 *
 * ## 为什么加在 tenant_models 而不是 tenant_settings
 * 模型条目本身就是「一套完整连接配置（端点 + 密钥 + 采样参数）」，
 * 复用它 = 不引入第二套密钥管理，也不会出现「配置里指着一个已被删掉的模型 id」这种悬空引用。
 * 用途是模型的**固有属性**（这个模型是干什么用的），不是「调参」——
 * 后者才是 tenant_settings 的地盘。
 *
 * ## 语义
 *  - chat    = 对话模型（默认）。租户没配任何 chat 模型时，对话走 .env 平台默认。
 *  - memory  = 记忆抽取模型。没配时抽取**回落到对话模型**（不配也能用，行为跟今天一样）。
 *  - summary = 会话摘要模型。没配时摘要**回落到对话模型**（B1 摘要压缩，见 migration 019）。
 *
 * 不变式从「每租户恰一条 is_active」变成「每租户**每个 scope** 恰一条 is_active」。
 * 存量数据全部落在 chat（DEFAULT 'chat'），原有租户的对话模型不受影响。
 *
 * 幂等：先查列在不在，有就直接跳过。
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  const columns = await listColumns(queryInterface, 'tenant_models');
  if (columns.has('usage_scope')) {
    return;
  }

  await queryInterface.addColumn('tenant_models', 'usage_scope', {
    type: DataTypes.ENUM('chat', 'memory', 'summary'),
    allowNull: false,
    defaultValue: 'chat',
    comment:
      '用途：chat=对话模型 / memory=记忆抽取模型 / summary=会话摘要模型' +
      '（memory / summary 没配时回落到 chat）',
  });

  // 存量数据兜底：MySQL 的 addColumn 带 DEFAULT 会把已有行填成 'chat'，
  // 但如果表里之前有 NULL（理论上不该有），统一收一遍，避免 NULL 破坏 scope 过滤。
  await queryInterface.sequelize.query(
    "UPDATE tenant_models SET usage_scope = 'chat' WHERE usage_scope IS NULL",
  );
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  const columns = await listColumns(queryInterface, 'tenant_models');
  if (!columns.has('usage_scope')) {
    return;
  }
  await queryInterface.removeColumn('tenant_models', 'usage_scope');
};
