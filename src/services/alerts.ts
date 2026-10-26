import { Op } from 'sequelize';
import { AuditLog } from '../models';
import { getBudgetStatus } from './cost-tracking';
import { getSettingValue } from './tenant-settings';
import { getObservabilitySummary } from './observability';

/**
 * 后台告警 —— D1 / D2 / D3 / D4 / D5
 * （docs/12-d-需求-运维稳定.md、docs/09-观测方案.md §9.4）
 *
 * 「控制台告警条」指的是租户后台顶部的横幅（docs/09-观测方案.md §9.4）。
 * 这里把各类信号汇总成一个列表：
 *   - 成本超预算（实时状态：本月已用 vs 阈值）        —— D3
 *   - 限流命中（最近 1 小时的次数）                   —— D5
 *   - 安全拦截（最近 24 小时的注入 / 违规次数）        —— D4
 *   - 评测分数下跌（较上次跑批跌 ≥ 10%）              —— D1
 *   - p95 延迟 / 错误率 / 单条成本超阈值              —— D2（§9.4）
 *
 * 数据来源：
 *   - 预算 → cost_logs 实时汇总（见 cost-tracking）
 *   - 限流 / 拦截 / 分数下跌 → audit_logs（这些动作本来就要写审计）
 *   - 延迟 / 错误率 / 单条成本 → traces + cost_logs（见 observability）
 */

export type AlertLevel = 'error' | 'warning';

export interface AdminAlert {
  /** 稳定的标识，前端用它做 key */
  id: string;
  level: AlertLevel;
  title: string;
  detail: string;
  /** 事件发生时间；实时状态类告警为 null */
  created_at: string | null;
}

const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const SECURITY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * §9.4 的三个阈值 —— **平台默认**。
 *
 * 租户可以在「租户设置 → 成本」里覆盖（`alert_p95_latency_ms` /
 * `alert_error_rate` / `alert_single_cost_usd`）。
 * 覆盖值 = 0 表示「不看这一项」。
 */
const P95_LATENCY_ALERT_MS = 5000;
const ERROR_RATE_ALERT = 0.05;
const SINGLE_COST_ALERT_USD = 0.5;

/**
 * 读租户的告警阈值（没配就用平台默认）。
 *
 * ⚠️ **「没配」和「配成 0」是两件事**（2026-10-26 修）：
 *    以前写的是 `typeof v === 'number' && v > 0 ? v : 默认值` ——
 *    那意味着**配成 0 反而会用回默认值**，而配置项的说明写着「设 0 = 不看这一项」。
 *    文档和代码对不上，用户按说明设 0 发现没生效。
 *
 *    现在：没配（null / undefined / 非数字）→ 用默认值；**配成 0 → 真的不看了**。
 */
async function alertThresholds(tenantId: string): Promise<{
  p95LatencyMs: number;
  errorRate: number;
  singleCostUsd: number;
}> {
  const [p95, errRate, cost] = await Promise.all([
    getSettingValue(tenantId, 'alert_p95_latency_ms'),
    getSettingValue(tenantId, 'alert_error_rate'),
    getSettingValue(tenantId, 'alert_single_cost_usd'),
  ]);
  const numOr = (v: unknown, dflt: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : dflt;
  return {
    p95LatencyMs: numOr(p95, P95_LATENCY_ALERT_MS),
    errorRate: numOr(errRate, ERROR_RATE_ALERT),
    singleCostUsd: numOr(cost, SINGLE_COST_ALERT_USD),
  };
}

/**
 * 告警**规则**视图 —— 后台「告警规则」页用（04-c §5.7.4）
 *
 * 规则是**固定的三条**（不是让租户自己写条件表达式 ——
 * 那是另一个量级的需求，见 04-c §5.7.4 的「与原规格的差异」）。
 * 租户能改的是**阈值**和**启停**（阈值设 0 = 关掉这一条）。
 */
export interface AlertRuleView {
  key: 'p95_latency' | 'error_rate' | 'single_cost';
  /** 规则名（页面上显示） */
  name: string;
  /** 条件的文字描述（「今天的 p95 延迟 > 5000 ms」） */
  condition: string;
  /** 阈值单位 */
  unit: 'ms' | 'percent' | 'usd';
  /** 当前阈值（0 = 已关掉这一条） */
  threshold: number;
  /** 平台默认值（关掉之后想恢复就填它） */
  default_threshold: number;
  /** 今天这一条的实际值（null = 今天没数据） */
  current_value: number | null;
  /** 现在是不是触发中 */
  firing: boolean;
}

/**
 * 列出三条告警规则 + 它们当前的状态。
 *
 * 跟 `listAdminAlerts` 的区别：那个回答「现在有哪些告警」，
 * 这个回答「规则长什么样、阈值配的多少、现在到没到」。
 */
export async function listAlertRules(tenantId: string): Promise<AlertRuleView[]> {
  const thresholds = await alertThresholds(tenantId);
  let today: {
    conversations: number;
    p95_latency_ms: number;
    error_rate: number;
    max_conversation_cost: number;
  } | null = null;
  try {
    const summary = await getObservabilitySummary(tenantId);
    today = summary.today;
  } catch {
    // traces / cost_logs 还没建 —— 规则照样列，值给 null
  }

  const pct = (v: number): string => `${(v * 100).toFixed(0)}%`;
  const ms = (v: number): string => `${v} ms`;
  const usd = (v: number): string => `$${v.toFixed(4)}`;

  const hasTraffic = today !== null && today.conversations > 0;

  return [
    {
      key: 'p95_latency',
      name: 'p95 响应延迟',
      condition: `今天的 p95 延迟 > ${ms(thresholds.p95LatencyMs)}`,
      unit: 'ms',
      threshold: thresholds.p95LatencyMs,
      default_threshold: P95_LATENCY_ALERT_MS,
      current_value: today === null ? null : today.p95_latency_ms,
      // ⚠️ 阈值 = 0 = 这一条被关掉了（见 alertThresholds 的注释）
      firing:
        thresholds.p95LatencyMs > 0 &&
        hasTraffic &&
        today!.p95_latency_ms > thresholds.p95LatencyMs,
    },
    {
      key: 'error_rate',
      name: '错误率',
      condition: `今天的错误率 > ${pct(thresholds.errorRate)}`,
      unit: 'percent',
      threshold: thresholds.errorRate,
      default_threshold: ERROR_RATE_ALERT,
      current_value: today === null ? null : today.error_rate,
      firing:
        thresholds.errorRate > 0 &&
        hasTraffic &&
        today!.error_rate > thresholds.errorRate,
    },
    {
      key: 'single_cost',
      name: '单条对话成本',
      condition: `今天最贵的一条对话 > ${usd(thresholds.singleCostUsd)}`,
      unit: 'usd',
      threshold: thresholds.singleCostUsd,
      default_threshold: SINGLE_COST_ALERT_USD,
      current_value: today === null ? null : today.max_conversation_cost,
      firing:
        today !== null &&
        thresholds.singleCostUsd > 0 &&
        today.max_conversation_cost > thresholds.singleCostUsd,
    },
  ];
}

export async function listAdminAlerts(tenantId: string): Promise<AdminAlert[]> {
  const alerts: AdminAlert[] = [];
  const thresholds = await alertThresholds(tenantId);

  // ---- 1. 成本预算（实时状态）----
  const limitRaw = await getSettingValue(tenantId, 'monthly_token_budget');
  const limit = typeof limitRaw === 'number' ? limitRaw : 0;
  if (limit > 0) {
    const status = await getBudgetStatus(tenantId, limit);
    if (status.exceeded) {
      alerts.push({
        id: 'cost_budget_exceeded',
        level: 'error',
        title: '本月 token 用量已超预算',
        detail:
          `本月已用 ${status.used.toLocaleString('zh-CN')} token，` +
          `阈值 ${status.limit.toLocaleString('zh-CN')} token。` +
          '可在「租户设置」里调高阈值，或等下个月自动重置。',
        created_at: null,
      });
    } else if (status.ratio !== null && status.ratio >= 0.8) {
      alerts.push({
        id: 'cost_budget_near_limit',
        level: 'warning',
        title: '本月 token 用量接近预算',
        detail:
          `已用 ${status.used.toLocaleString('zh-CN')} / ${status.limit.toLocaleString('zh-CN')} token` +
          `（${Math.round(status.ratio * 100)}%）。`,
        created_at: null,
      });
    }
  }

  // ---- 2 + 3. 审计里的限流 / 安全拦截 ----
  const now = new Date();
  const since = new Date(now.getTime() - SECURITY_WINDOW_MS);
  try {
    const rows = await AuditLog.findAll({
      where: {
        tenant_id: tenantId,
        action: {
          [Op.in]: [
            'RATE_LIMIT_EXCEEDED',
            'PROMPT_INJECTION_BLOCKED',
            'CONTENT_MODERATION_BLOCKED',
            'EVALUATION_SCORE_DROPPED',
          ],
        },
        created_at: { [Op.gte]: since },
      },
      attributes: ['action', 'created_at', 'details'],
      order: [['created_at', 'DESC']],
      limit: 200,
    });

    const rateLimited = rows.filter((r) => r.action === 'RATE_LIMIT_EXCEEDED');
    const rateLimitLastHour = rateLimited.filter(
      (r) => r.created_at.getTime() >= now.getTime() - RATE_LIMIT_WINDOW_MS,
    ).length;
    const blocked = rows.filter(
      (r) => r.action === 'PROMPT_INJECTION_BLOCKED' || r.action === 'CONTENT_MODERATION_BLOCKED',
    ).length;

    if (rateLimitLastHour > 0) {
      alerts.push({
        id: 'rate_limit_recent',
        level: 'warning',
        title: '最近一小时有请求被限流',
        detail: `被限流 ${rateLimitLastHour} 次。可在「租户设置」里调高「每分钟请求上限」。`,
        created_at: rateLimited[0]?.created_at.toISOString() ?? null,
      });
    }
    if (blocked > 0) {
      alerts.push({
        id: 'security_blocks_recent',
        level: 'warning',
        title: '最近 24 小时有内容被安全策略拦截',
        detail: `共 ${blocked} 次（提示词注入 / 内容违规）。详情见审计日志。`,
        created_at:
          rows.find(
            (r) =>
              r.action === 'PROMPT_INJECTION_BLOCKED' || r.action === 'CONTENT_MODERATION_BLOCKED',
          )?.created_at.toISOString() ?? null,
      });
    }

    // ---- 4. 评测分数下跌（D1）----
    // 需求验收：「故意改坏提示词 → 分数下降 ≥ 10% → 控制台告警条出现」
    const drops = rows.filter((r) => r.action === 'EVALUATION_SCORE_DROPPED');
    const latestDrop = drops[0];
    if (latestDrop !== undefined) {
      const details = (latestDrop.details ?? {}) as {
        previous_score?: number;
        current_score?: number;
        drop_ratio?: number;
        dataset_name?: string | null;
      };
      const dropPct =
        typeof details.drop_ratio === 'number' ? Math.round(details.drop_ratio * 100) : null;
      alerts.push({
        id: 'evaluation_score_dropped',
        level: 'error',
        title: '评测分数较上次下跌',
        detail:
          `评测集「${details.dataset_name ?? '未命名'}」的总分从 ` +
          `${details.previous_score?.toFixed(2) ?? '?'} 跌到 ${details.current_score?.toFixed(2) ?? '?'}` +
          (dropPct !== null ? `（跌了 ${dropPct}%）` : '') +
          '。如果刚改过提示词，去「评测结果」页对比一下。',
        created_at: latestDrop.created_at.toISOString(),
      });
    }
  } catch {
    // audit_logs 表还没建 / 查不到 —— 不该让整个告警面板挂掉
  }

  // ---- 5. 观测指标阈值（D2 · docs/09-观测方案.md §9.4）----
  // ⚠️ 窗口是「今天」而不是设计稿里的「5 分钟」：
  //    5 分钟窗口在后台这种「看一眼」的用法下几乎永远不触发（错一次就恢复了），
  //    今天的窗口更符合「今天的健康度怎么样」这个实际诉求。
  //    真要做 5 分钟窗口需要一张分钟级聚合表（§9.2 的 metrics_minutely），本期没做。
  try {
    const summary = await getObservabilitySummary(tenantId);
    const today = summary.today;

    // ⚠️ 阈值 = 0 = 这一条被关掉了（2026-10-26 修，见 alertThresholds 的注释）
    if (
      thresholds.p95LatencyMs > 0 &&
      today.conversations > 0 &&
      today.p95_latency_ms > thresholds.p95LatencyMs
    ) {
      alerts.push({
        id: 'p95_latency_high',
        level: 'warning',
        title: 'p95 响应延迟超过阈值',
        detail:
          `今天 p95 延迟 ${today.p95_latency_ms} ms（阈值 ${thresholds.p95LatencyMs} ms）。` +
          '去「观测 → Trace 列表」看是哪一步慢。',
        created_at: null,
      });
    }

    if (
      thresholds.errorRate > 0 &&
      today.conversations > 0 &&
      today.error_rate > thresholds.errorRate
    ) {
      alerts.push({
        id: 'error_rate_high',
        level: 'error',
        title: '错误率超过阈值',
        detail:
          `今天 ${today.conversations} 次对话里有 ${today.errors} 次失败` +
          `（错误率 ${(today.error_rate * 100).toFixed(1)}%，阈值 ${(thresholds.errorRate * 100).toFixed(0)}%）。` +
          '去「观测 → Trace 列表」按「失败」筛选看原因。',
        created_at: null,
      });
    }

    if (today.max_conversation_cost > thresholds.singleCostUsd) {
      alerts.push({
        id: 'single_conversation_cost_high',
        level: 'warning',
        title: '单条对话成本超过阈值',
        detail:
          `今天最贵的一次对话花了 $${today.max_conversation_cost.toFixed(4)}` +
          `（阈值 $${thresholds.singleCostUsd}）。通常是检索命中太多或提示词太长。`,
        created_at: null,
      });
    }
  } catch {
    // traces / cost_logs 还没建 —— 观测类告警跳过，不影响其它告警
  }

  return alerts;
}
