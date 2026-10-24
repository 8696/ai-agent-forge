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

/** §9.4 的三个阈值 */
const P95_LATENCY_ALERT_MS = 5000;
const ERROR_RATE_ALERT = 0.05;
const SINGLE_COST_ALERT_USD = 0.5;

export async function listAdminAlerts(tenantId: string): Promise<AdminAlert[]> {
  const alerts: AdminAlert[] = [];

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

    if (today.conversations > 0 && today.p95_latency_ms > P95_LATENCY_ALERT_MS) {
      alerts.push({
        id: 'p95_latency_high',
        level: 'warning',
        title: 'p95 响应延迟超过阈值',
        detail:
          `今天 p95 延迟 ${today.p95_latency_ms} ms（阈值 ${P95_LATENCY_ALERT_MS} ms）。` +
          '去「观测 → Trace 列表」看是哪一步慢。',
        created_at: null,
      });
    }

    if (today.conversations > 0 && today.error_rate > ERROR_RATE_ALERT) {
      alerts.push({
        id: 'error_rate_high',
        level: 'error',
        title: '错误率超过阈值',
        detail:
          `今天 ${today.conversations} 次对话里有 ${today.errors} 次失败` +
          `（错误率 ${(today.error_rate * 100).toFixed(1)}%，阈值 ${(ERROR_RATE_ALERT * 100).toFixed(0)}%）。` +
          '去「观测 → Trace 列表」按「失败」筛选看原因。',
        created_at: null,
      });
    }

    if (today.max_conversation_cost > SINGLE_COST_ALERT_USD) {
      alerts.push({
        id: 'single_conversation_cost_high',
        level: 'warning',
        title: '单条对话成本超过阈值',
        detail:
          `今天最贵的一次对话花了 $${today.max_conversation_cost.toFixed(4)}` +
          `（阈值 $${SINGLE_COST_ALERT_USD}）。通常是检索命中太多或提示词太长。`,
        created_at: null,
      });
    }
  } catch {
    // traces / cost_logs 还没建 —— 观测类告警跳过，不影响其它告警
  }

  return alerts;
}
