import { QueryTypes } from 'sequelize';
import { sequelize } from '../db';
import { logger } from '../logger';
import { utcWallClock } from '../lib/sql-datetime';

/**
 * 平台方跨租户统计 —— docs/04-d-ui-系统级与公共组件.md §6.2（/system/dashboard）
 *
 * 与租户级的 `getObservabilitySummary`（src/services/observability.ts）的区别：
 *   - **不按 tenant_id 过滤** —— 平台方视角就是看全部租户
 *   - 多一层「租户维度」的汇总：租户数 / 状态分布 / 哪些租户本月超预算
 *
 * ⚠️ 这个口径**只对 system 角色开放**（路由层 requireSystemUser 是唯一的闸门）。
 *    租户 admin 永远拿不到跨租户的数字。
 *
 * 表还没建（traces / cost_logs 是 D2 / D3 才加的）时，观测类的数字按 0 处理，
 * 租户数 / 用户数照常给 —— 不能因为一张可选表缺失就整个面板挂掉。
 */

export interface SystemTenantStats {
  total: number;
  active: number;
  disabled: number;
  /** 已过期的租户（expires_at < now），其中一部分可能也是 disabled */
  expired: number;
  plans: Array<{ plan: string; count: number }>;
}

export interface SystemOverBudgetTenant {
  tenant_id: string;
  code: string;
  name: string;
  used: number;
  limit: number;
}

export interface SystemStats {
  tenants: SystemTenantStats;
  users: { tenant_users: number; system_users: number };
  today: {
    conversations: number;
    errors: number;
    error_rate: number;
    cost: number;
    total_tokens: number;
  };
  trend: Array<{ date: string; conversations: number; cost: number; errors: number }>;
  /** 本月 token 超预算的租户（按用量从多到少） */
  over_budget: SystemOverBudgetTenant[];
}

function toNum(v: string | number | null | undefined): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export async function getSystemStats(now: Date = new Date()): Promise<SystemStats> {
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const weekStart = new Date(dayStart.getTime() - 6 * 24 * 3600 * 1000);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  // ---- 租户 / 用户：这两张表从 Step 2 就有，一定存在 ----
  const [statusRows, planRows, expiredRow, userRow, systemUserRow] = await Promise.all([
    sequelize.query<{ status: string; count: string | number }>(
      `SELECT status, COUNT(*) AS count FROM tenants GROUP BY status`,
      { type: QueryTypes.SELECT },
    ),
    sequelize.query<{ plan: string; count: string | number }>(
      `SELECT plan, COUNT(*) AS count FROM tenants GROUP BY plan`,
      { type: QueryTypes.SELECT },
    ),
    sequelize.query<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM tenants WHERE expires_at IS NOT NULL AND expires_at < ?`,
      { replacements: [utcWallClock(now)], type: QueryTypes.SELECT },
    ),
    sequelize.query<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM users`,
      { type: QueryTypes.SELECT },
    ),
    sequelize.query<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM system_users`,
      { type: QueryTypes.SELECT },
    ),
  ]);

  const tenants: SystemTenantStats = {
    total: 0,
    active: 0,
    disabled: 0,
    expired: toNum(expiredRow[0]?.count),
    plans: planRows.map((r) => ({ plan: String(r.plan), count: toNum(r.count) })),
  };
  for (const r of statusRows) {
    const n = toNum(r.count);
    tenants.total += n;
    if (r.status === 'disabled') {
      tenants.disabled += n;
    } else {
      tenants.active += n;
    }
  }

  const users = {
    tenant_users: toNum(userRow[0]?.count),
    system_users: toNum(systemUserRow[0]?.count),
  };

  // ---- 观测数字：traces / cost_logs 是 D2 / D3 才加的，可能还不存在 ----
  let today: SystemStats['today'] = {
    conversations: 0,
    errors: 0,
    error_rate: 0,
    cost: 0,
    total_tokens: 0,
  };
  let trend: SystemStats['trend'] = [];
  let overBudget: SystemOverBudgetTenant[] = [];

  try {
    const [traceAggRows, costAggRows, trendRows] = await Promise.all([
      sequelize.query<{ conversations: string | number; errors: string | number }>(
        `SELECT COUNT(*) AS conversations,
                SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors
           FROM traces
          WHERE started_at >= ? AND started_at < ?`,
        { replacements: [utcWallClock(dayStart), utcWallClock(dayEnd)], type: QueryTypes.SELECT },
      ),
      sequelize.query<{ cost: string | number; total_tokens: string | number }>(
        `SELECT COALESCE(SUM(cost), 0) AS cost, COALESCE(SUM(total_tokens), 0) AS total_tokens
           FROM cost_logs
          WHERE created_at >= ? AND created_at < ?`,
        { replacements: [utcWallClock(dayStart), utcWallClock(dayEnd)], type: QueryTypes.SELECT },
      ),
      sequelize.query<{
        bucket: string;
        conversations: string | number;
        errors: string | number;
        cost: string | number;
      }>(
        `SELECT d.bucket,
                COALESCE(t.conversations, 0) AS conversations,
                COALESCE(t.errors, 0) AS errors,
                COALESCE(c.cost, 0) AS cost
           FROM (
             SELECT DATE(created_at) AS bucket FROM cost_logs
              WHERE created_at >= ? AND created_at < ?
              GROUP BY DATE(created_at)
           ) d
           LEFT JOIN (
             SELECT DATE(started_at) AS bucket, COUNT(*) AS conversations,
                    SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors
               FROM traces
              WHERE started_at >= ? AND started_at < ?
              GROUP BY DATE(started_at)
           ) t ON t.bucket = d.bucket
           LEFT JOIN (
             SELECT DATE(created_at) AS bucket, SUM(cost) AS cost FROM cost_logs
              WHERE created_at >= ? AND created_at < ?
              GROUP BY DATE(created_at)
           ) c ON c.bucket = d.bucket
          ORDER BY d.bucket ASC`,
        {
          replacements: [
            utcWallClock(weekStart),
            utcWallClock(dayEnd),
            utcWallClock(weekStart),
            utcWallClock(dayEnd),
            utcWallClock(weekStart),
            utcWallClock(dayEnd),
          ],
          type: QueryTypes.SELECT,
        },
      ),
    ]);

    const conversations = toNum(traceAggRows[0]?.conversations);
    const errors = toNum(traceAggRows[0]?.errors);
    today = {
      conversations,
      errors,
      error_rate: conversations === 0 ? 0 : Number((errors / conversations).toFixed(4)),
      cost: Number(toNum(costAggRows[0]?.cost).toFixed(6)),
      total_tokens: toNum(costAggRows[0]?.total_tokens),
    };
    trend = trendRows.map((r) => ({
      date: String(r.bucket),
      conversations: toNum(r.conversations),
      cost: Number(toNum(r.cost).toFixed(6)),
      errors: toNum(r.errors),
    }));
  } catch (err: unknown) {
    // traces / cost_logs 还没建 —— 观测数字按 0，租户数照常
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      '读平台观测统计失败（traces/cost_logs 可能还没建）',
    );
  }

  // ---- 本月超预算的租户 ----
  // 只看**显式配过** monthly_token_budget 的租户 —— 平台默认值是 0（不限），
  // 没有行的租户不该出现在这个列表里。
  try {
    const [budgetRows, usageRows] = await Promise.all([
      sequelize.query<{
        tenant_id: string;
        code: string;
        name: string;
        config_value: string;
      }>(
        `SELECT s.tenant_id, t.code, t.name, s.config_value
           FROM tenant_settings s
           JOIN tenants t ON t.id = s.tenant_id
          WHERE s.config_key = 'monthly_token_budget'`,
        { type: QueryTypes.SELECT },
      ),
      sequelize.query<{ tenant_id: string; used: string | number }>(
        `SELECT tenant_id, COALESCE(SUM(total_tokens), 0) AS used
           FROM cost_logs
          WHERE created_at >= ?
          GROUP BY tenant_id`,
        { replacements: [utcWallClock(monthStart)], type: QueryTypes.SELECT },
      ),
    ]);

    const usedByTenant = new Map(usageRows.map((r) => [String(r.tenant_id), toNum(r.used)]));
    overBudget = budgetRows
      .map((r) => ({
        tenant_id: String(r.tenant_id),
        code: String(r.code),
        name: String(r.name),
        used: usedByTenant.get(String(r.tenant_id)) ?? 0,
        limit: toNum(r.config_value),
      }))
      // limit <= 0 = 不限，不算超预算
      .filter((t) => t.limit > 0 && t.used > t.limit)
      .sort((a, b) => b.used / b.limit - a.used / a.limit);
  } catch (err: unknown) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      '读租户预算失败（tenant_settings / cost_logs 可能还没建）',
    );
  }

  return { tenants, users, today, trend, over_budget: overBudget };
}
