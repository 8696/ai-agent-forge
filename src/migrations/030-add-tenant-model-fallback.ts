import { DataTypes, QueryTypes, type QueryInterface } from 'sequelize';
import type { MigrationFn } from 'umzug';

/**
 * tenant_models 加一列 `fallback_model_id` —— 备用模型（C4）
 *
 * ## 为什么加
 *
 * 04-c §5.4.1 的**原规格**里就有「备用模型下拉」，实现时被换成了
 * 「模型列表 + 启用切换」（那解决的是「自建网关 + 官方 API 并存」的表达问题，
 * 但没解决「主模型挂了自动顶上」）。
 *
 * docs/06 §6.3 写的「当前 MVP 不做自动 failover」—— 现在做。
 * 判定标准是**「当前一个系统能做完」**：备用模型是租户自己配的另一条模型条目，
 * 平台在调用失败时切过去，**不跨系统**。
 *
 * ## 语义
 *
 * - 指向**同租户、同 scope** 的另一条模型条目（chat 的备用不能是 memory 的 ——
 *   用途不同，成本也不同）
 * - 主模型调用失败（provider 报错 / 连不上）**且一个 token 都还没吐出去**时，
 *   自动切到备用模型重试一次
 * - ⚠️ **已经吐过内容就不切了** —— 吐出去的字收不回来，重来会重复内容
 *
 * ## 索引
 *
 * idx_tenant_models_fallback (tenant_id, fallback_model_id) —— 按备用关系查
 *
 * 幂等：列已存在就跳过。
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  const sequelize = queryInterface.sequelize;

  const [rows] = await sequelize.query<{ COLUMN_NAME: string }>(
    'SELECT COLUMN_NAME FROM information_schema.COLUMNS ' +
      'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    { replacements: ['tenant_models', 'fallback_model_id'], type: QueryTypes.SELECT },
  );
  if (Array.isArray(rows) && rows.length > 0) {
    return;
  }

  await sequelize.query(
    'ALTER TABLE tenant_models ADD COLUMN fallback_model_id VARCHAR(36) NULL ' +
      "COMMENT '备用模型（指向同租户同 scope 的另一条模型条目；主模型失败时自动顶上）'",
  );
  await sequelize.query(
    'CREATE INDEX idx_tenant_models_fallback ON tenant_models (tenant_id, fallback_model_id)',
  );
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.query('DROP INDEX idx_tenant_models_fallback ON tenant_models');
  await queryInterface.sequelize.query(
    'ALTER TABLE tenant_models DROP COLUMN fallback_model_id',
  );
};
