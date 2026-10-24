import { Op } from 'sequelize';
import { AuditLog } from '../models';
import { getBudgetStatus } from './cost-tracking';
import { getSettingValue } from './tenant-settings';

/**
 * 后台告警 —— D3 / D4 / D5（docs/12-d-需求-运维稳定.md）
 *
 * 「控制台告警条」指的是租户后台顶部的横幅（docs/09-观测方案.md §9.4）。
 * 这里把三类信号汇总成一个列表：
 *   - 成本超预算（实时状态：本月已用 vs 阈值）
 *   - 限流命中（最近 1 小时的次数）
 *   - 安全拦截（最近 24 小时的注入 / 违规次数）
 *
 * 数据来源：
 *   - 预算 → cost_logs 实时汇总（见 cost-tracking）
 *   - 限流 / 拦截 → audit_logs（这些动作本来就要写审计）
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
          [Op.in]: ['RATE_LIMIT_EXCEEDED', 'PROMPT_INJECTION_BLOCKED', 'CONTENT_MODERATION_BLOCKED'],
        },
        created_at: { [Op.gte]: since },
      },
      attributes: ['action', 'created_at'],
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
        created_at: rateLimitLastHour > 0 ? (rateLimited[0]?.created_at.toISOString() ?? null) : null,
      });
    }
    if (blocked > 0) {
      alerts.push({
        id: 'security_blocks_recent',
        level: 'warning',
        title: '最近 24 小时有内容被安全策略拦截',
        detail: `共 ${blocked} 次（提示词注入 / 内容违规）。详情见审计日志。`,
        created_at: rows.find(
          (r) =>
            r.action === 'PROMPT_INJECTION_BLOCKED' || r.action === 'CONTENT_MODERATION_BLOCKED',
        )?.created_at.toISOString() ?? null,
      });
    }
  } catch {
    // audit_logs 表还没建 / 查不到 —— 不该让整个告警面板挂掉
  }

  return alerts;
}
