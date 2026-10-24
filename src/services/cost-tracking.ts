import { Op, fn, col } from 'sequelize';
import { CostLog } from '../models';
import { logger } from '../logger';
import { writeAuditLog } from '../lib/audit-log';
import { estimateCostUsd, type CostUsage } from '../lib/cost-pricing';

/**
 * 成本跟踪 —— D3（docs/12-d-需求-运维稳定.md §D3）
 *
 * 三件事：
 *   1. 每次 LLM 调用后写一行 `cost_logs`（token 明细 + 估算花费）
 *   2. 维护「本月已用 token」的进程内累计（避免每次都去 DB SUM）
 *   3. 超过租户月度阈值时写 audit_logs 告警
 *
 * ## 为什么用「进程内累计 + DB 回源」而不是每次查 DB
 * 每个回答结束都要看一眼预算，如果每次都 `SELECT SUM(...)`：
 *   - 一次对话 = 一次额外查询，高并发下这条查询会出现在慢查询日志里
 *   - 累计逻辑放在进程内，DB 只在「进程刚起来 / 换了月份」时回源一次
 *
 * 代价：多实例部署时每个实例各算各的，合计 ≈ 实例数 × 真实值。
 * 这是已知的取舍（同限流），单实例部署没有这个问题。
 */

export interface LlmUsageRecord {
  tenantId: string;
  userId: string | null;
  sessionId: string | null;
  messageId: string | null;
  provider: string | null;
  model: string | null;
  usage: CostUsage;
}

/** 进程内月度累计：tenantId → { month, tokens } */
interface MonthAccumulator {
  month: string;
  tokens: number;
}

const accumulators = new Map<string, MonthAccumulator>();

/** 当前月份标识（本地时区，'YYYY-MM'） */
export function currentMonth(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/** 本月起止时间（本地时区） */
export function monthRange(now: Date = new Date()): { start: Date; end: Date } {
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return { start, end };
}

/**
 * 写一条成本流水，并把 token 记进进程内累计。
 *
 * 写库失败不抛错 —— 成本记账失败不该让用户的回答失败。
 * 但要 warn 一行，不能静默丢数据。
 */
export async function recordLlmUsage(record: LlmUsageRecord): Promise<void> {
  const { usage } = record;
  const totalTokens =
    usage.input_tokens + usage.output_tokens + usage.cache_read_tokens + usage.cache_write_tokens;
  const cost = record.model === null ? 0 : estimateCostUsd(record.model, usage);

  try {
    await CostLog.create({
      tenant_id: record.tenantId,
      user_id: record.userId,
      session_id: record.sessionId,
      message_id: record.messageId,
      provider: record.provider,
      model: record.model,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read_tokens: usage.cache_read_tokens,
      cache_write_tokens: usage.cache_write_tokens,
      total_tokens: totalTokens,
      cost,
    });
  } catch (err: unknown) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), tenantId: record.tenantId },
      '写成本流水失败',
    );
  }

  addToAccumulator(record.tenantId, totalTokens);
}

/** 累加进程内计数（跨月自动重置） */
function addToAccumulator(tenantId: string, tokens: number): void {
  const month = currentMonth();
  const existing = accumulators.get(tenantId);
  if (existing === undefined || existing.month !== month) {
    accumulators.set(tenantId, { month, tokens });
    return;
  }
  existing.tokens += tokens;
}

/**
 * 本月已用 token。
 *
 * 进程内有记录就用进程内的（快）；没有就回 DB 查一次并把结果缓存进进程内。
 */
export async function getMonthlyTokenUsage(tenantId: string): Promise<number> {
  const month = currentMonth();
  const existing = accumulators.get(tenantId);
  if (existing !== undefined && existing.month === month) {
    return existing.tokens;
  }

  // 进程刚起来 / 跨月：回源一次
  const { start, end } = monthRange();
  try {
    const row = await CostLog.findOne({
      where: {
        tenant_id: tenantId,
        created_at: { [Op.gte]: start, [Op.lt]: end },
      },
      attributes: [[fn('SUM', col('total_tokens')), 'total']],
      raw: true,
    });
    const total = Number((row as { total?: string | number } | null)?.total ?? 0);
    const tokens = Number.isFinite(total) ? total : 0;
    accumulators.set(tenantId, { month, tokens });
    return tokens;
  } catch (err: unknown) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), tenantId },
      '统计本月 token 失败，按 0 算',
    );
    return 0;
  }
}

export interface BudgetStatus {
  /** 阈值（token）；0 = 不限 */
  limit: number;
  /** 本月已用 token */
  used: number;
  /** 还能用多少；不限时为 null */
  remaining: number | null;
  /** 是否已超阈值 */
  exceeded: boolean;
  /** 超了百分之多少（0~1+）；不限时为 null */
  ratio: number | null;
}

/**
 * 取预算状态。
 *
 * @param limit 租户配置的月度阈值（0 / null = 不限）
 */
export async function getBudgetStatus(tenantId: string, limit: number): Promise<BudgetStatus> {
  const used = await getMonthlyTokenUsage(tenantId);
  if (limit <= 0) {
    return { limit: 0, used, remaining: null, exceeded: false, ratio: null };
  }
  const remaining = Math.max(0, limit - used);
  return {
    limit,
    used,
    remaining,
    exceeded: used > limit,
    ratio: used / limit,
  };
}

/**
 * 超阈值告警 —— 写一条 audit_logs。
 *
 * 每次调用都会检查，但**同一个租户同一个月的告警只写一次**：
 * 不然超了之后每轮对话都写一条，audit_logs 会被刷爆。
 * 用进程内 Set 记住「本月已告警」。
 */
const alertedThisMonth = new Set<string>();

export function resetBudgetAlerts(): void {
  alertedThisMonth.clear();
}

export async function checkBudgetAndAlert(
  tenantId: string,
  limit: number,
): Promise<BudgetStatus> {
  const status = await getBudgetStatus(tenantId, limit);
  if (!status.exceeded) {
    return status;
  }

  const key = `${tenantId}:${currentMonth()}`;
  if (alertedThisMonth.has(key)) {
    return status;
  }
  alertedThisMonth.add(key);

  logger.warn(
    { tenantId, used: status.used, limit: status.limit },
    '租户本月 token 用量已超预算阈值',
  );
  await writeAuditLog({
    tenant_id: tenantId,
    user_id: null,
    action: 'COST_BUDGET_EXCEEDED',
    resource_type: 'tenant',
    resource_id: tenantId,
    details: {
      used_tokens: status.used,
      limit_tokens: status.limit,
      month: currentMonth(),
    },
  });
  return status;
}

/** 清空进程内累计（只给测试用） */
export function resetCostAccumulators(): void {
  accumulators.clear();
}
