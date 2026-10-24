import { DataTypes, type QueryInterface } from 'sequelize';
import type { MigrationFn } from 'umzug';

/**
 * 评测表 —— D1（docs/12-d-需求-运维稳定.md §D1）
 *
 * 四张表，对应评测的四个概念：
 *   evaluation_datasets  评测集（一次上传的题目集合）
 *   evaluation_items     题目（question / reference_answer / scenario / difficulty）
 *   evaluation_runs      一次跑批（结果：4 维分数 + 总成本）
 *   evaluation_results   每条题目的打分明细（4 维分数 + 裁判理由）
 *
 * ## 为什么 run 和 result 分开
 * 「跑批」是一个整体结论（分数趋势、成本），「每条题的明细」是排查用的。
 * 分开之后「这次跑批比上次跌了多少」只需查 runs 表（很轻），
 * 不用去 results 表做聚合。
 *
 * 索引：
 *  - (tenant_id, created_at) —— 列表页主查询
 *  - (dataset_id) —— 取某个评测集的题目
 *  - (run_id) —— 取某次跑批的明细
 *
 * 不加外键（跟 audit_logs / cost_logs / traces 一致）：删除靠应用层，
 * 数据库层的外键在跨子系统查询多的时候只会拖累写入。
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.createTable('evaluation_datasets', {
    id: {
      type: DataTypes.STRING(36),
      primaryKey: true,
      allowNull: false,
      comment: '评测集 id（nanoid 21）',
    },
    tenant_id: {
      type: DataTypes.STRING(36),
      allowNull: false,
      comment: '所属租户',
    },
    name: {
      type: DataTypes.STRING(100),
      allowNull: false,
      comment: '评测集名称',
    },
    version: {
      type: DataTypes.STRING(32),
      allowNull: false,
      defaultValue: 'v1',
      comment: '版本号（同一个名字可以有多版）',
    },
    description: {
      type: DataTypes.STRING(500),
      allowNull: true,
      comment: '备注',
    },
    item_count: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: '题目条数',
    },
    created_by: {
      type: DataTypes.STRING(36),
      allowNull: true,
      comment: '创建人',
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

  await queryInterface.addIndex('evaluation_datasets', ['tenant_id', 'created_at'], {
    name: 'idx_eval_datasets_tenant_created',
  });

  await queryInterface.createTable('evaluation_items', {
    id: {
      type: DataTypes.STRING(36),
      primaryKey: true,
      allowNull: false,
      comment: '题目 id（nanoid 21）',
    },
    dataset_id: {
      type: DataTypes.STRING(36),
      allowNull: false,
      comment: '所属评测集',
    },
    tenant_id: {
      type: DataTypes.STRING(36),
      allowNull: false,
      comment: '所属租户（冗余一份，方便按租户直接查）',
    },
    question: {
      type: DataTypes.TEXT,
      allowNull: false,
      comment: '题目',
    },
    reference_answer: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: '参考答案（可空；为空时裁判只看准确性）',
    },
    scenario: {
      type: DataTypes.STRING(64),
      allowNull: true,
      comment: '场景标签（如「年假 / 报销」）',
    },
    difficulty: {
      type: DataTypes.STRING(16),
      allowNull: true,
      comment: '难度：easy / medium / hard',
    },
    created_at: {
      type: DataTypes.DATE(6),
      allowNull: false,
      defaultValue: queryInterface.sequelize.literal('CURRENT_TIMESTAMP(6)'),
      comment: '创建时间',
    },
  });

  await queryInterface.addIndex('evaluation_items', ['dataset_id'], {
    name: 'idx_eval_items_dataset',
  });

  await queryInterface.createTable('evaluation_runs', {
    id: {
      type: DataTypes.STRING(36),
      primaryKey: true,
      allowNull: false,
      comment: '跑批 id（nanoid 21）',
    },
    tenant_id: {
      type: DataTypes.STRING(36),
      allowNull: false,
      comment: '所属租户',
    },
    dataset_id: {
      type: DataTypes.STRING(36),
      allowNull: false,
      comment: '评测集 id',
    },
    dataset_name: {
      type: DataTypes.STRING(100),
      allowNull: true,
      comment: '评测集名称快照（评测集改名 / 删除后还能看）',
    },
    prompt_version: {
      type: DataTypes.STRING(64),
      allowNull: true,
      comment: '这次跑批用的提示词版本（null = 内置默认）',
    },
    model: {
      type: DataTypes.STRING(100),
      allowNull: true,
      comment: '实际使用的模型 id',
    },
    provider: {
      type: DataTypes.STRING(32),
      allowNull: true,
      comment: 'provider',
    },
    status: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: 'running',
      comment: 'running / completed / failed',
    },
    total_items: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: '题目总数',
    },
    completed_items: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: '已完成条数（跑批过程中用来显示进度）',
    },
    accuracy: {
      type: DataTypes.FLOAT,
      allowNull: true,
      comment: '准确性（0~5 的平均分）',
    },
    completeness: {
      type: DataTypes.FLOAT,
      allowNull: true,
      comment: '完整性（0~5 的平均分）',
    },
    style: {
      type: DataTypes.FLOAT,
      allowNull: true,
      comment: '风格（0~5 的平均分）',
    },
    safety: {
      type: DataTypes.FLOAT,
      allowNull: true,
      comment: '安全性（0~5 的平均分）',
    },
    total_score: {
      type: DataTypes.FLOAT,
      allowNull: true,
      comment: '四维平均（0~5）—— 趋势对比看这个',
    },
    total_tokens: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: '本次跑批消耗的总 token（含生成 + 裁判）',
    },
    total_cost: {
      type: DataTypes.DECIMAL(12, 6),
      allowNull: false,
      defaultValue: 0,
      comment: '本次跑批的估算花费（USD）',
    },
    error_message: {
      type: DataTypes.STRING(500),
      allowNull: true,
      comment: '失败原因',
    },
    started_at: {
      type: DataTypes.DATE(6),
      allowNull: false,
      comment: '开始时间',
    },
    finished_at: {
      type: DataTypes.DATE(6),
      allowNull: true,
      comment: '结束时间',
    },
    created_at: {
      type: DataTypes.DATE(6),
      allowNull: false,
      defaultValue: queryInterface.sequelize.literal('CURRENT_TIMESTAMP(6)'),
      comment: '创建时间',
    },
  });

  await queryInterface.addIndex('evaluation_runs', ['tenant_id', 'created_at'], {
    name: 'idx_eval_runs_tenant_created',
  });
  await queryInterface.addIndex('evaluation_runs', ['dataset_id', 'created_at'], {
    name: 'idx_eval_runs_dataset_created',
  });

  await queryInterface.createTable('evaluation_results', {
    id: {
      type: DataTypes.STRING(36),
      primaryKey: true,
      allowNull: false,
      comment: '明细 id（nanoid 21）',
    },
    run_id: {
      type: DataTypes.STRING(36),
      allowNull: false,
      comment: '所属跑批',
    },
    tenant_id: {
      type: DataTypes.STRING(36),
      allowNull: false,
      comment: '所属租户',
    },
    item_id: {
      type: DataTypes.STRING(36),
      allowNull: true,
      comment: '对应题目 id',
    },
    question: {
      type: DataTypes.TEXT,
      allowNull: false,
      comment: '题目快照',
    },
    answer: {
      type: DataTypes.TEXT,
      allowNull: false,
      comment: '模型回答',
    },
    reference_answer: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: '参考答案快照',
    },
    scores: {
      type: DataTypes.JSON,
      allowNull: false,
      comment: '4 维分数 {accuracy, completeness, style, safety}（各 0~5）',
    },
    judge_reason: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: '裁判给出的理由',
    },
    input_tokens: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: '生成 + 裁判消耗的输入 token',
    },
    output_tokens: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: '生成 + 裁判消耗的输出 token',
    },
    cost: {
      type: DataTypes.DECIMAL(12, 6),
      allowNull: false,
      defaultValue: 0,
      comment: '这一条的估算花费（USD）',
    },
    latency_ms: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: '这一条的总耗时（毫秒）',
    },
    created_at: {
      type: DataTypes.DATE(6),
      allowNull: false,
      defaultValue: queryInterface.sequelize.literal('CURRENT_TIMESTAMP(6)'),
      comment: '创建时间',
    },
  });

  await queryInterface.addIndex('evaluation_results', ['run_id'], {
    name: 'idx_eval_results_run',
  });

  await queryInterface.sequelize.query(
    "ALTER TABLE evaluation_datasets COMMENT = '评测集（D1 评测）'",
  );
  await queryInterface.sequelize.query(
    "ALTER TABLE evaluation_items COMMENT = '评测题目（D1 评测）'",
  );
  await queryInterface.sequelize.query(
    "ALTER TABLE evaluation_runs COMMENT = '评测跑批（D1 评测）'",
  );
  await queryInterface.sequelize.query(
    "ALTER TABLE evaluation_results COMMENT = '评测打分明细（D1 评测）'",
  );
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.dropTable('evaluation_results');
  await queryInterface.dropTable('evaluation_runs');
  await queryInterface.dropTable('evaluation_items');
  await queryInterface.dropTable('evaluation_datasets');
};
