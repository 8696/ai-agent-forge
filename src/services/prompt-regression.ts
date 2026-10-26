import { config } from '../config';
import { logger } from '../logger';
import { listDatasets, startEvaluationRun } from './evaluation';
import { promptVersionExists } from './prompt-registry';

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
 *    「用指定版本的提示词跑」—— **2026-10-26 已经支持了**
 *    （`startEvaluationRun({ promptVersion })`），但门禁本身还没做：
 *    发布流程要等跑批结果（几十秒到几分钟），那是另一个改动。
 *
 * ## 它跑的是哪个版本
 *
 * **显式传刚发布的那个版本号**，不靠「当前生效指针」——
 * 发布和回归之间隔着一次 HTTP 请求，中间租户可能又发了一版。
 * 显式指定才不会跑偏（版本不存在会直接跳过，不会静默用默认提示词）。
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

  // 指定的版本不存在 → 不触发（**不抛错**）
  //
  // ⚠️ 回归现在**显式用刚发布的那个版本**跑，所以版本必须真的存在。
  //    万一它被并发删了，宁可不回归，也**不能悄悄用默认提示词跑** ——
  //    那份分数会被当成「这一版的分数」看，结论就是错的。
  if (!(await promptVersionExists(params.tenantId, params.promptVersion))) {
    return { triggered: false, reason: `提示词版本「${params.promptVersion}」不存在` };
  }

  const run = await startEvaluationRun(
    params.tenantId,
    params.userId,
    dataset.id,
    {
      limit: PROMPT_REGRESSION_MAX_ITEMS,
      trigger: 'prompt_regression',
      // 显式用刚发布的这个版本 —— 不依赖「当前生效指针」
      promptVersion: params.promptVersion,
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
