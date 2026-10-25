import { Op, Sequelize, type WhereOptions } from 'sequelize';
import { ToolCallLog, type ToolCallStatus } from '../models';
import { NotFoundError } from '../lib/errors';
import { logger } from '../logger';
import type { ToolCallRecord } from '../tools/execute';

/**
 * 工具调用流水 —— B3 工具调用（docs/12-b-需求-ai对话能力.md §B3）
 *
 * 一行 = 一次工具调用。后台的「工具调用记录」页读这张表。
 *
 * ## 写入时机
 *
 * 由工具执行包装层（`src/tools/execute.ts`）在每次调用结束时触发 ——
 * 那是所有工具调用的**唯一出口**，所以不会漏记。
 *
 * ⚠️ **写库失败不影响工具结果**（观测是旁路）——
 *    用户的对话该成功就得成功，不能因为日志写不进去而失败。
 */
export interface ToolCallLogView {
  id: string;
  tool_call_id: string;
  /** 注册名（模型调用的就是这个名字） */
  tool_name: string;
  /** 内置实现 key */
  builtin: string | null;
  status: ToolCallStatus;
  /** 请求参数（模型给的入参） */
  args: unknown;
  /** 响应参数（工具的返回值） */
  output: unknown;
  error: string | null;
  duration_ms: number;
  session_id: string | null;
  user_id: string | null;
  message_id: string | null;
  trace_id: string | null;
  created_at: string;
}

export function toToolCallLogView(row: ToolCallLog): ToolCallLogView {
  return {
    id: row.id,
    tool_call_id: row.tool_call_id,
    tool_name: row.tool_name,
    builtin: row.builtin,
    status: row.status,
    args: row.args,
    output: row.output,
    error: row.error,
    duration_ms: row.duration_ms,
    session_id: row.session_id,
    user_id: row.user_id,
    message_id: row.message_id,
    trace_id: row.trace_id,
    created_at: row.created_at.toISOString(),
  };
}

/** 写一条工具调用流水 */
export async function writeToolCallLog(params: {
  tenantId: string;
  sessionId: string | null;
  userId: string | null;
  messageId: string | null;
  traceId: string | null;
  record: ToolCallRecord;
}): Promise<void> {
  try {
    await ToolCallLog.create({
      tenant_id: params.tenantId,
      session_id: params.sessionId,
      user_id: params.userId,
      message_id: params.messageId,
      tool_call_id: params.record.tool_call_id,
      tool_name: params.record.tool_name,
      builtin: params.record.builtin,
      status: params.record.status,
      args: params.record.args ?? null,
      output: params.record.output ?? null,
      error: params.record.error,
      duration_ms: params.record.duration_ms,
      trace_id: params.traceId,
    });
  } catch (err: unknown) {
    // 写流水失败只 warn —— 不能让工具调用整轮挂掉（跟 trace 一个道理）
    logger.warn(
      { err, tool: params.record.tool_name },
      '工具调用流水写入失败（不影响对话）',
    );
  }
}

export interface ToolCallLogListParams {
  page: number;
  pageSize: number;
  /** 按工具名精确筛 */
  toolName?: string | undefined;
  /** 按状态精确筛 */
  status?: ToolCallStatus | undefined;
  /** 按会话筛 */
  sessionId?: string | undefined;
  /** 起始时间 */
  from?: Date | undefined;
  /** 结束时间 */
  to?: Date | undefined;
  /** 模糊搜：入参 / 返回值里包含这个串 */
  keyword?: string | undefined;
}

export interface ToolCallLogListResult {
  logs: ToolCallLogView[];
  pagination: { page: number; page_size: number; total: number; total_pages: number };
}

export async function listToolCallLogs(
  tenantId: string,
  params: ToolCallLogListParams,
): Promise<ToolCallLogListResult> {
  // 用 Record 而不是 WhereOptions —— WhereOptions 不让用 Op.or 当索引键，
  // 最后整体 cast 回去（Sequelize 运行时认 Op.or）
  const where: Record<string | symbol, unknown> = { tenant_id: tenantId };

  if (params.toolName !== undefined && params.toolName !== '') {
    where.tool_name = params.toolName;
  }
  if (params.status !== undefined) {
    where.status = params.status;
  }
  if (params.sessionId !== undefined && params.sessionId !== '') {
    where.session_id = params.sessionId;
  }
  if (params.from !== undefined || params.to !== undefined) {
    where.created_at = {
      ...(params.from !== undefined ? { [Op.gte]: params.from } : {}),
      ...(params.to !== undefined ? { [Op.lte]: params.to } : {}),
    };
  }
  if (params.keyword !== undefined && params.keyword !== '') {
    // 入参 / 返回值是 JSON 列，直接 LIKE 匹配不上 —— 先 CAST 成字符串再模糊匹配
    // （精度一般，够「找一条包含某个订单号的调用」用）
    const like = `%${params.keyword}%`;
    where[Op.or] = [
      Sequelize.where(Sequelize.literal('CAST(args AS CHAR)'), { [Op.like]: like }),
      Sequelize.where(Sequelize.literal('CAST(output AS CHAR)'), { [Op.like]: like }),
    ];
  }

  const { rows, count } = await ToolCallLog.findAndCountAll({
    where: where as WhereOptions<ToolCallLog>,
    order: [['created_at', 'DESC'], ['id', 'DESC']],
    limit: params.pageSize,
    offset: (params.page - 1) * params.pageSize,
  });

  return {
    logs: rows.map(toToolCallLogView),
    pagination: {
      page: params.page,
      page_size: params.pageSize,
      total: count,
      total_pages: Math.max(1, Math.ceil(count / params.pageSize)),
    },
  };
}

/** 本租户调用过的工具名（给筛选下拉框用） */
export async function listToolCallNames(tenantId: string): Promise<string[]> {
  const rows = await ToolCallLog.findAll({
    where: { tenant_id: tenantId },
    attributes: ['tool_name'],
    order: [['tool_name', 'ASC']],
  });
  return [...new Set(rows.map((r) => r.tool_name))];
}

export async function getToolCallLog(tenantId: string, id: string): Promise<ToolCallLog> {
  const row = await ToolCallLog.findOne({ where: { id, tenant_id: tenantId } });
  if (row === null) {
    throw new NotFoundError('工具调用记录');
  }
  return row;
}
