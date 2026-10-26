import { config } from '../config';
import { logger } from '../logger';
import { listDatasets, startEvaluationRun } from './evaluation';

/**
 * 提示词发布 → 自动跑一次小规模回归
 * （D1「已知边界」里那条「prompt 改动自动跑小规模回归」，2026-10-26 补上）
 *
 * ## 它是什么
 *
 * 提示词发布之后，**自动**用新发布的提示词跑一小段评测集，
 * 让租户在「评测跑批」列表里直接看到「这次改动跑下来多少分」，
 * 分数跌了 10% 会触发既有的 `EVALUATION_SCORE_DROPPED` 告警（D1 已有）。
 *
 * ## 为什么是「小规模」
 *
 * 一次题 = **2 次 LLM 调用**（生成 + 裁判）。50 题就是 100 次调用 ——
 * 挂在发布流程上等它跑完是不可接受的（发布按钮会卡住）。
 *
 * 所以：跑批本身是**异步**的（接口立刻返回，后台跑），
 * 而且只跑**前 N 题**（默认 10）。
 *
 * ## 它不是「发布前门禁」
 *
 * ⚠️ 新提示词**已经生效**了才跑回归 —— 这是「发布后验证」，
 *    不是「不发就不能发」。
 *
 *    要做成门禁（先跑草稿、分数达标才允许发布）得让评测支持
 *    「用指定版本的提示词跑」（现在跑批用的是**生效中的**提示词），
 *    那是另一个改动。
 *
 * ## 它永远不会让发布失败
 *
 * 没配评测集 / 评测功能关着 / 起跑失败 —— 一律**跳过**，只记一条日志。
 * 提示词发布是主流程，不能被一个「锦上添花的回归」拖垮。
 */
export const PROMPT_REGRESSION_MAX_ITEMS = 10;

export interface PromptRegressionOutcome {
  /** 有没有真的触发 */
  triggered: boolean;
  /** 没触发的原因（给日志看） */
  reason?: string;
  /** 触发了的话，跑批 id */
  runId?: string;
}

/**
 * 触发一次提示词回归。
 *
 * @param promptVersion 刚发布的版本号（只用于日志与排查）
 */
export async function triggerPromptRegression(params: {
  tenantId: string;
  userId: string | null;
  promptVersion: string;
}): Promise<PromptRegressionOutcome> {
  if (!config.EVALUATION.ENABLED) {
    return { triggered: false, reason: '评测功能未开启' };
  }

  // 租户没建评测集 → 没有东西可回归
  const datasets = await listDatasets(params.tenantId);
  const dataset = datasets[0];
  if (dataset === undefined) {
    return { triggered: false, reason: '租户还没有评测集，没什么可回归' };
  }
  if (dataset.item_count === 0) {
    return { triggered: false, reason: '评测集是空的' };
  }

  const run = await startEvaluationRun(
    params.tenantId,
    params.userId,
    dataset.id,
    {
      limit: PROMPT_REGRESSION_MAX_ITEMS,
      trigger: 'prompt_regression',
    },
  );

  logger.info(
    {
      tenantId: params.tenantId,
      promptVersion: params.promptVersion,
      runId: run.id,
      dataset: dataset.name,
      limit: PROMPT_REGRESSION_MAX_ITEMS,
    },
    '提示词已发布，自动跑了一次小规模回归',
  );

  return { triggered: true, runId: run.id };
}

/**
 * 提示词发布后的自动回归 —— **fire-and-forget**。
 *
 * ⚠️ **所有失败都吞掉**：提示词发布已经成功了，
 *    一个「锦上添花的回归」跑不起来不该让发布接口报错。
 */
export async function triggerPromptRegressionSafe(params: {
  tenantId: string;
  userId: string | null;
  promptVersion: string;
}): Promise<void> {
  try {
    await triggerPromptRegression(params);
  } catch (err: unknown) {
    logger.warn(
      { err, promptVersion: params.promptVersion },
      '提示词发布的自动回归没跑起来（不影响发布）',
    );
  }
}
