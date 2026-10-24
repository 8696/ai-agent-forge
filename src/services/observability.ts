import { Op, QueryTypes } from 'sequelize';
import { sequelize } from '../db';
import { CostLog, Session, Span, Trace, User } from '../models';
import { logger } from '../logger';

/**
 * 观测查询 —— D2（docs/12-d-需求-运维稳定.md §D2）
 *
 * 回答四个问题：
 *   1. 最近有哪些对话？跑得慢不慢？出错没？   → listTraces / getTraceDetail
 *   2. 这条对话慢在哪一步？                      → getTraceDetail 的 spans 时间线
 *   3. 钱花在哪了？按什么维度拆？                → getCostAnalysis
 *   4. 今天的健康度怎么样？                      → getObservabilitySummary
 *
 * ## 跨租户
 * 所有查询强制带 `tenant_id`（从 JWT 取，路由层保证）。
 * 这是**唯一一个必须按租户过滤**的地方 —— traces/spans 表没有 Sequelize scope，
 * 写查询时自己带条件，别新增一个不带 tenant_id 的查询。
 */

export interface TraceListParams {
  page: number;
  pageSize: number;
  status?: 'success' | 'error' | undefined;
  userId?: string | undefined;
  sessionId?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
}

export interface TraceListRow {
  id: string;
  tenant_id: string;
  user_id: string | null;
  session_id: string | null;
  name: string;
  kind: string;
  status: string;
  channel: string | null;
  provider: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost: number;
  duration_ms: number | null;
  error_message: string | null;
  started_at: string;
  ended_at: string | null;
}

export interface TraceListResult {
  traces: TraceListRow[];
  pagination: { page: number; page_size: number; total: number; total_pages: number };
}

export async function listTraces(
  tenantId: string,
  params: TraceListParams,
): Promise<TraceListResult> {
  const where: Record<string, unknown> = { tenant_id: tenantId };
  if (params.status !== undefined) {
    where['status'] = params.status;
  }
  if (params.userId !== undefined && params.userId !== '') {
    where['user_id'] = params.userId;
  }
  if (params.sessionId !== undefined && params.sessionId !== '') {
    where['session_id'] = params.sessionId;
  }
  if (params.from !== undefined || params.to !== undefined) {
    where['started_at'] = {
      ...(params.from !== undefined ? { [Op.gte]: params.from } : {}),
      ...(params.to !== undefined ? { [Op.lte]: params.to } : {}),
    };
  }

  const { rows, count } = await Trace.findAndCountAll({
    where,
    order: [['started_at', 'DESC']],
    limit: params.pageSize,
    offset: (params.page - 1) * params.pageSize,
  });

  return {
    traces: rows.map((t) => ({
      id: t.id,
      tenant_id: t.tenant_id,
      user_id: t.user_id,
      session_id: t.session_id,
      name: t.name,
      kind: t.kind,
      status: t.status,
      channel: t.channel,
      provider: t.provider,
      model: t.model,
      input_tokens: t.input_tokens,
      output_tokens: t.output_tokens,
      total_tokens: t.total_tokens,
      cost: Number(t.cost),
      duration_ms: t.duration_ms,
      error_message: t.error_message,
      started_at: t.started_at.toISOString(),
      ended_at: t.ended_at === null ? null : t.ended_at.toISOString(),
    })),
    pagination: {
      page: params.page,
      page_size: params.pageSize,
      total: count,
      total_pages: Math.ceil(count / params.pageSize),
    },
  };
}

export interface SpanRow {
  id: string;
  trace_id: string;
  parent_span_id: string | null;
  name: string;
  kind: string;
  status: string;
  duration_ms: number | null;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error_message: string | null;
  started_at: string;
  ended_at: string | null;
}

export interface TraceDetail {
  trace: TraceListRow & { metadata: Record<string, unknown> | null };
  spans: SpanRow[];
}

/** 取一条 trace + 它的 span 时间线。别人的 trace 一律按「不存在」处理（404，不泄露 id 是否存在） */
export async function getTraceDetail(
  tenantId: string,
  traceId: string,
): Promise<TraceDetail | null> {
  const trace = await Trace.findOne({ where: { id: traceId, tenant_id: tenantId } });
  if (trace === null) {
    return null;
  }

  const spans = await Span.findAll({
    where: { trace_id: traceId, tenant_id: tenantId },
    order: [['started_at', 'ASC']],
  });

  return {
    trace: {
      id: trace.id,
      tenant_id: trace.tenant_id,
      user_id: trace.user_id,
      session_id: trace.session_id,
      name: trace.name,
      kind: trace.kind,
      status: trace.status,
      channel: trace.channel,
      provider: trace.provider,
      model: trace.model,
      input_tokens: trace.input_tokens,
      output_tokens: trace.output_tokens,
      total_tokens: trace.total_tokens,
      cost: Number(trace.cost),
      duration_ms: trace.duration_ms,
      error_message: trace.error_message,
      started_at: trace.started_at.toISOString(),
      ended_at: trace.ended_at === null ? null : trace.ended_at.toISOString(),
      metadata: trace.metadata,
    },
    spans: spans.map((s) => ({
      id: s.id,
      trace_id: s.trace_id,
      parent_span_id: s.parent_span_id,
      name: s.name,
      kind: s.kind,
      status: s.status,
      duration_ms: s.duration_ms,
      input: s.input,
      output: s.output,
      error_message: s.error_message,
      started_at: s.started_at.toISOString(),
      ended_at: s.ended_at === null ? null : s.ended_at.toISOString(),
    })),
  };
}

// ============================================================
// 成本分析
// ============================================================

export type CostRange = 'day' | 'week' | 'month' | 'custom';
export type CostGroupBy = 'model' | 'user' | 'channel' | 'provider';

export interface CostRangeParams {
  range: CostRange;
  from?: Date | undefined;
  to?: Date | undefined;
  groupBy: CostGroupBy;
}

export interface CostBucket {
  /** 分桶键（按天是 'YYYY-MM-DD'；按维度是 model / user id / channel） */
  key: string;
  /** 展示名 */
  label: string;
  calls: number;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cost: number;
}

export interface CostAnalysis {
  range: { from: string; to: string; range: CostRange };
  totals: {
    calls: number;
    total_tokens: number;
    input_tokens: number;
    output_tokens: number;
    cost: number;
  };
  /** 按天的趋势 */
  series: CostBucket[];
  /** 按所选维度拆解 */
  breakdown: CostBucket[];
  group_by: CostGroupBy;
}

/** 解析时间范围。custom 用 from/to；其余按本地时区推导 */
export function resolveCostRange(params: {
  range: CostRange;
  from?: Date | undefined;
  to?: Date | undefined;
  now?: Date;
}): { from: Date; to: Date } {
  const now = params.now ?? new Date();
  switch (params.range) {
    case 'day': {
      const from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      return { from, to };
    }
    case 'week': {
      const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
      const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      return { from, to };
    }
    case 'month': {
      const from = new Date(now.getFullYear(), now.getMonth(), 1);
      const to = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      return { from, to };
    }
    case 'custom': {
      const from = params.from ?? new Date(now.getTime() - 7 * 24 * 3600 * 1000);
      const to = params.to ?? now;
      return { from, to };
    }
  }
}

interface CostAggRow {
  bucket: string;
  calls: string | number;
  total_tokens: string | number;
  input_tokens: string | number;
  output_tokens: string | number;
  cost: string | number;
}

function toNum(v: string | number | null | undefined): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** 把一行聚合结果转成 CostBucket */
function toBucket(row: CostAggRow, label?: string): CostBucket {
  return {
    key: String(row.bucket),
    label: label ?? String(row.bucket),
    calls: toNum(row.calls),
    total_tokens: toNum(row.total_tokens),
    input_tokens: toNum(row.input_tokens),
    output_tokens: toNum(row.output_tokens),
    cost: Number(toNum(row.cost).toFixed(6)),
  };
}

/**
 * 成本分析。
 *
 * 数据源是 `cost_logs`（D3 建的表，一行一次 LLM 调用）而不是 `traces`：
 * cost_logs 的粒度更细（一次对话可能调多次模型），而且带 model / provider 维度，
 * 「按模型拆」才拆得出来。
 *
 * 「按渠道拆」需要 sessions 表的 channel —— 用一次 IN 查询把 session_id → channel
 * 映射出来，不做 JOIN（session_id 可空，JOIN 还得处理左连接）。
 */
export async function getCostAnalysis(
  tenantId: string,
  params: CostRangeParams,
): Promise<CostAnalysis> {
  const { from, to } = resolveCostRange(params);
  const where = {
    tenant_id: tenantId,
    created_at: { [Op.gte]: from, [Op.lt]: to },
  };

  const [seriesRows, breakdownRows] = await Promise.all([
    sequelize.query<CostAggRow>(
      `SELECT DATE(created_at) AS bucket,
              COUNT(*) AS calls,
              SUM(total_tokens) AS total_tokens,
              SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              SUM(cost) AS cost
         FROM cost_logs
        WHERE tenant_id = ? AND created_at >= ? AND created_at < ?
     GROUP BY DATE(created_at)
     ORDER BY bucket ASC`,
      { replacements: [tenantId, from, to], type: QueryTypes.SELECT },
    ),
    sequelize.query<CostAggRow>(
      `SELECT ${groupColumn(params.groupBy)} AS bucket,
              COUNT(*) AS calls,
              SUM(total_tokens) AS total_tokens,
              SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              SUM(cost) AS cost
         FROM cost_logs
        WHERE tenant_id = ? AND created_at >= ? AND created_at < ?
     GROUP BY bucket
     ORDER BY cost DESC`,
      { replacements: [tenantId, from, to], type: QueryTypes.SELECT },
    ),
  ]);

  // 按渠道拆时把 session_id 映射成可读标签
  let labels: Map<string, string> = new Map();
  if (params.groupBy === 'channel') {
    labels = await loadSessionChannels(tenantId, breakdownRows);
  } else if (params.groupBy === 'user') {
    labels = await loadUserEmails(tenantId, breakdownRows);
  } else if (params.groupBy === 'model') {
    labels = new Map(breakdownRows.map((r) => [String(r.bucket), String(r.bucket)]));
  }

  const breakdown = breakdownRows.map((r) => {
    const key = String(r.bucket);
    return toBucket(r, labels.get(key) ?? key);
  });

  const totals = breakdown.reduce(
    (acc, b) => ({
      calls: acc.calls + b.calls,
      total_tokens: acc.total_tokens + b.total_tokens,
      input_tokens: acc.input_tokens + b.input_tokens,
      output_tokens: acc.output_tokens + b.output_tokens,
      cost: Number((acc.cost + b.cost).toFixed(6)),
    }),
    { calls: 0, total_tokens: 0, input_tokens: 0, output_tokens: 0, cost: 0 },
  );

  return {
    range: { from: from.toISOString(), to: to.toISOString(), range: params.range },
    totals,
    series: seriesRows.map((r) => toBucket(r)),
    breakdown,
    group_by: params.groupBy,
  };
}

/** 拆解维度对应的 SQL 列（白名单，避免拼接注入） */
function groupColumn(groupBy: CostGroupBy): string {
  switch (groupBy) {
    case 'model':
      return "COALESCE(model, '未知模型')";
    case 'provider':
      return "COALESCE(provider, '未知 provider')";
    case 'user':
      return "COALESCE(user_id, '匿名')";
    case 'channel':
      return 'COALESCE(session_id, \'无会话\')';
  }
}

async function loadSessionChannels(
  tenantId: string,
  rows: CostAggRow[],
): Promise<Map<string, string>> {
  const sessionIds = rows
    .map((r) => String(r.bucket))
    .filter((id) => id !== '无会话' && id !== 'NULL');
  if (sessionIds.length === 0) {
    return new Map();
  }
  try {
    const sessions = await Session.findAll({
      where: { tenant_id: tenantId, id: { [Op.in]: sessionIds } },
      attributes: ['id', 'channel'],
    });
    return new Map(sessions.map((s) => [s.id, s.channel]));
  } catch (err: unknown) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, '读会话渠道失败');
    return new Map();
  }
}

async function loadUserEmails(
  tenantId: string,
  rows: CostAggRow[],
): Promise<Map<string, string>> {
  const userIds = rows.map((r) => String(r.bucket)).filter((id) => id !== '匿名' && id !== 'NULL');
  if (userIds.length === 0) {
    return new Map();
  }
  try {
    const users = await User.findAll({
      where: { tenant_id: tenantId, id: { [Op.in]: userIds } },
      attributes: ['id', 'email'],
    });
    return new Map(users.map((u) => [u.id, u.email]));
  } catch (err: unknown) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, '读用户邮箱失败');
    return new Map();
  }
}

// ============================================================
// 汇总（Dashboard 用）
// ============================================================

export interface ObservabilitySummary {
  today: {
    conversations: number;
    p95_latency_ms: number;
    avg_latency_ms: number;
    cost: number;
    total_tokens: number;
    error_rate: number;
    errors: number;
    /** 今天最贵的一次对话（USD）—— 09.4 的「单条对话成本 > $0.5」告警用 */
    max_conversation_cost: number;
  };
  /** 最近 7 天（含今天）的趋势 */
  trend: Array<{ date: string; conversations: number; cost: number; errors: number }>;
}

/**
 * 汇总指标。
 *
 * p95 用窗口函数精确算（MySQL 8.0 没有 PERCENTILE_CONT）：
 * 先按 duration 排序编号，取第 ceil(n*0.95) 行。
 */
export async function getObservabilitySummary(
  tenantId: string,
  now: Date = new Date(),
): Promise<ObservabilitySummary> {
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const weekStart = new Date(dayStart.getTime() - 6 * 24 * 3600 * 1000);

  const [traceAggRows, costAggRows, p95Rows, trendRows, maxCostRows] = await Promise.all([
    sequelize.query<{
      conversations: string | number;
      errors: string | number;
      avg_duration: string | number;
    }>(
      `SELECT COUNT(*) AS conversations,
              SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
              AVG(duration_ms) AS avg_duration
         FROM traces
        WHERE tenant_id = ? AND started_at >= ? AND started_at < ?`,
      { replacements: [tenantId, dayStart, dayEnd], type: QueryTypes.SELECT },
    ),
    sequelize.query<{ cost: string | number; total_tokens: string | number }>(
      `SELECT COALESCE(SUM(cost), 0) AS cost, COALESCE(SUM(total_tokens), 0) AS total_tokens
         FROM cost_logs
        WHERE tenant_id = ? AND created_at >= ? AND created_at < ?`,
      { replacements: [tenantId, dayStart, dayEnd], type: QueryTypes.SELECT },
    ),
    sequelize.query<{ duration_ms: string | number | null }>(
      `SELECT duration_ms FROM (
         SELECT duration_ms,
                ROW_NUMBER() OVER (ORDER BY duration_ms) AS rn,
                COUNT(*) OVER () AS cnt
           FROM traces
          WHERE tenant_id = ? AND started_at >= ? AND started_at < ? AND duration_ms IS NOT NULL
       ) t
       WHERE rn = GREATEST(1, CEIL(cnt * 0.95))
       LIMIT 1`,
      { replacements: [tenantId, dayStart, dayEnd], type: QueryTypes.SELECT },
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
            WHERE tenant_id = ? AND created_at >= ? AND created_at < ?
            GROUP BY DATE(created_at)
         ) d
         LEFT JOIN (
           SELECT DATE(started_at) AS bucket, COUNT(*) AS conversations,
                  SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors
             FROM traces
            WHERE tenant_id = ? AND started_at >= ? AND started_at < ?
            GROUP BY DATE(started_at)
         ) t ON t.bucket = d.bucket
         LEFT JOIN (
           SELECT DATE(created_at) AS bucket, SUM(cost) AS cost FROM cost_logs
            WHERE tenant_id = ? AND created_at >= ? AND created_at < ?
            GROUP BY DATE(created_at)
         ) c ON c.bucket = d.bucket
     ORDER BY d.bucket ASC`,
      {
        replacements: [
          tenantId, weekStart, dayEnd,
          tenantId, weekStart, dayEnd,
          tenantId, weekStart, dayEnd,
        ],
        type: QueryTypes.SELECT,
      },
    ),
    sequelize.query<{ max_cost: string | number | null }>(
      `SELECT MAX(cost) AS max_cost FROM traces
        WHERE tenant_id = ? AND started_at >= ? AND started_at < ?`,
      { replacements: [tenantId, dayStart, dayEnd], type: QueryTypes.SELECT },
    ),
  ]);

  const traceAgg = traceAggRows[0];
  const costAgg = costAggRows[0];
  const conversations = toNum(traceAgg?.conversations);
  const errors = toNum(traceAgg?.errors);

  return {
    today: {
      conversations,
      p95_latency_ms: toNum(p95Rows[0]?.duration_ms),
      avg_latency_ms: Math.round(toNum(traceAgg?.avg_duration)),
      cost: Number(toNum(costAgg?.cost).toFixed(6)),
      total_tokens: toNum(costAgg?.total_tokens),
      error_rate: conversations === 0 ? 0 : Number((errors / conversations).toFixed(4)),
      errors,
      max_conversation_cost: Number(toNum(maxCostRows[0]?.max_cost).toFixed(6)),
    },
    trend: trendRows.map((r) => ({
      date: String(r.bucket),
      conversations: toNum(r.conversations),
      cost: Number(toNum(r.cost).toFixed(6)),
      errors: toNum(r.errors),
    })),
  };
}

/** 供集成测试清理用 */
export async function deleteTenantTraces(tenantId: string): Promise<void> {
  await Span.destroy({ where: { tenant_id: tenantId } });
  await Trace.destroy({ where: { tenant_id: tenantId } });
  await CostLog.destroy({ where: { tenant_id: tenantId } });
}
