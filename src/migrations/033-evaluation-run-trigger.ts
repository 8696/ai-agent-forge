import { DataTypes, QueryTypes, type QueryInterface } from 'sequelize';
import type { MigrationFn } from 'umzug';

/**
 * evaluation_runs 加两列 —— 提示词发布自动回归（D1 的「prompt 改动自动跑小规模回归」）
 *
 * ## 为什么加
 *
 * 2026-10-26 之前，「改完提示词自动跑一次小规模回归」在 12-d §D1 里标的是**没做**。
 * 按「当前一个系统能不能端到端做完」的标准，它是**纯内部**的，所以这轮补上。
 *
 * ## 两列
 *
 * - `run_trigger` —— 这次跑批**是怎么来的**：`manual`（手动点）/ `prompt_regression`
 *   （提示词发布自动触发）。
 *   ⚠️ **必须有** —— 否则用户在「评测跑批」列表里看到一条莫名出现的 run，
 *   不知道是谁触发的、为什么跑。
 *   ⚠️ **列名不能叫 `trigger`** —— 那是 MySQL 的保留字。
 * - `item_limit` —— 这次只跑了前 N 题（`NULL` = 跑全集）。
 *   「小规模回归」的关键就是**少跑几题**：一次题 = 2 次 LLM 调用，
 *   50 题就是 100 次调用，不适合挂在发布流程上。
 *
 * ## 索引
 *
 * idx_evaluation_runs_trigger (tenant_id, trigger) —— 「只看提示词回归触发的」
 *
 * 幂等：列已存在就跳过。
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  const sequelize = queryInterface.sequelize;

  const existing = await sequelize.query<{ COLUMN_NAME: string }>(
    'SELECT COLUMN_NAME FROM information_schema.COLUMNS ' +
      'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    { replacements: ['evaluation_runs', 'run_trigger'], type: QueryTypes.SELECT },
  );
  if (Array.isArray(existing) && existing.length > 0) {
    return;
  }

  // ⚠️ 列名**不能叫 `trigger`** —— 那是 MySQL 的保留字（`ADD COLUMN trigger` 直接语法错）
  await sequelize.query(
    'ALTER TABLE evaluation_runs ADD COLUMN run_trigger VARCHAR(32) NOT NULL DEFAULT \'manual\' ' +
      "COMMENT '触发方式：manual=手动 / prompt_regression=提示词发布自动回归'",
  );
  await sequelize.query(
    'ALTER TABLE evaluation_runs ADD COLUMN item_limit INT NULL ' +
      "COMMENT '本次只跑前 N 题（NULL = 跑全集）；小规模回归用'",
  );
  await sequelize.query(
    'CREATE INDEX idx_evaluation_runs_trigger ON evaluation_runs (tenant_id, run_trigger)',
  );
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.query('DROP INDEX idx_evaluation_runs_trigger ON evaluation_runs');
  await queryInterface.sequelize.query('ALTER TABLE evaluation_runs DROP COLUMN item_limit');
  await queryInterface.sequelize.query('ALTER TABLE evaluation_runs DROP COLUMN run_trigger');
};
