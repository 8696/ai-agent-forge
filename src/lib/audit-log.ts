import { Op } from 'sequelize';
import { AuditLog, User, type AuditAction } from '../models';
import { logger } from '../logger';

/**
 * AuditLog 写入封装 —— F2 + Step 12 共用
 * 详见 docs/16-e-需求-业务接入与平台运营.md F2 / docs/16-d-需求-运维稳定.md D5
 *
 * 设计要点：
 *  - 不抛错：如果表不存在（早期 Step 12 还没跑 006 迁移）或写失败，warn 一行就返回。
 *    这样 F2 / 后续 Step 写点审计时不会被审计本身阻塞业务。
 *  - system 子系统的操作传 `tenant_id: null`（系统级日志）。
 *  - ip 默认从 `ctx.ip` 取（Koajs 会自动从 X-Forwarded-For 解析）。
 */
export interface WriteAuditLogParams {
  /** 所属租户；system 子系统写操作传 NULL */
  tenant_id: string | null;
  /** 触发用户 ID（system 子系统传 system_user.id） */
  user_id: string | null;
  /** 操作类型（详见 AuditAction 联合类型） */
  action: AuditAction | string;
  /** 资源类型（可选，例：'tenant' / 'user' / 'document' / 'settings'） */
  resource_type?: string | null;
  /** 资源 ID（可选） */
  resource_id?: string | null | undefined;
  /** 操作详情（前后值 / 失败原因等，JSON 序列化） */
  details?: unknown;
  /** 客户端 IP */
  ip?: string | null;
}

export async function writeAuditLog(params: WriteAuditLogParams): Promise<void> {
  try {
    await AuditLog.create({
      tenant_id: params.tenant_id,
      user_id: params.user_id,
      action: params.action,
      resource_type: params.resource_type ?? null,
      resource_id: params.resource_id ?? null,
      details: params.details ?? null,
      ip: params.ip ?? null,
    });
  } catch (e: unknown) {
    // 表不存在（早期未跑 006 迁移）或字段不一致 —— 静默 downgrade，不阻塞业务
    // "表不存在" 是已知早期状态（migration 未跑 / 测试 mock），降到 debug 不污染输出；
    // 其他真异常（连接挂 / 约束冲突 / 权限错）保留 warn 以保可见性。
    const err = e as { name?: string; message?: string; original?: { code?: string } };
    const msg = err.message ?? String(e);
    const isTableMissing =
      err.original?.code === 'ER_NO_SUCH_TABLE' ||
      /Table .*(doesn't|not) exist/i.test(msg) ||
      // 模型没注册到 Sequelize 实例上（纯单元测试里 import 了 service 但没连 DB）
      /needs to be added to a Sequelize instance/i.test(msg);
    const level = isTableMissing ? 'debug' : 'warn';
    logger[level](
      {
        audit: params,
        err: msg,
        err_name: err.name ?? null,
      },
      'audit log write failed',
    );
  }
}

// ============================================================
// 读侧 —— 审计日志查询（D5 的「读」半边）
// ============================================================

export interface AuditListParams {
  /** 页码，从 1 开始 */
  page: number;
  /** 每页条数 */
  pageSize: number;
  /** 按操作者过滤（users.id） */
  userId?: string | undefined;
  /** 按操作类型过滤（精确匹配 action） */
  action?: string | undefined;
  /** 按资源类型过滤（精确匹配 resource_type） */
  resourceType?: string | undefined;
  /** 起始时间（含） */
  from?: Date | undefined;
  /** 结束时间（含） */
  to?: Date | undefined;
}

/** 列表里的一行 */
export interface AuditLogItem {
  id: string;
  tenant_id: string;
  /** 操作者 id；系统级操作里可能是 system_users.id */
  user_id: string | null;
  /** 操作者邮箱；查不到（用户已删 / 系统账号）时为 null */
  user_email: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  details: unknown;
  ip: string | null;
  created_at: string;
}

export interface AuditPagination {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
}

export interface AuditListResult {
  logs: AuditLogItem[];
  pagination: AuditPagination;
}

/**
 * 列本租户的审计日志（分页 + 筛选）
 *
 * ⚠️ **租户隔离是这个函数的核心不变量**，不要动：
 *   - where 里 `tenant_id` 是**等值比较**。SQL 里 `NULL = 'acme'` 恒为 false，
 *     所以**系统级日志（tenant_id IS NULL —— 平台方改租户启停 / 到期时间那类）
 *     天然被排除在租户 admin 的视野之外**，不需要额外的 `IS NULL` 判断。
 *   - 反过来，别的租户的日志也拿不到 —— tenant_id 是审计表上唯一的租户锚点。
 *   - ⚠️ 千万别把这里改成 `Op.or` / `Op.ne` 之类的写法：
 *     一旦变成 `tenant_id = 'x' OR tenant_id IS NULL`，系统级日志就漏给租户 admin 了。
 */
export async function listAuditLogs(
  tenantId: string,
  params: AuditListParams,
): Promise<AuditListResult> {
  if (typeof tenantId !== 'string' || tenantId === '') {
    // 拿不到租户锚点就不查 —— 宁可空列表，也不做「无过滤的全表查询」
    return {
      logs: [],
      pagination: { page: params.page, page_size: params.pageSize, total: 0, total_pages: 0 },
    };
  }

  const where: Record<string, unknown> = { tenant_id: tenantId };
  if (params.userId !== undefined && params.userId !== '') {
    where['user_id'] = params.userId;
  }
  if (params.action !== undefined && params.action !== '') {
    where['action'] = params.action;
  }
  if (params.resourceType !== undefined && params.resourceType !== '') {
    where['resource_type'] = params.resourceType;
  }
  if (params.from !== undefined || params.to !== undefined) {
    where['created_at'] = {
      ...(params.from !== undefined ? { [Op.gte]: params.from } : {}),
      ...(params.to !== undefined ? { [Op.lte]: params.to } : {}),
    };
  }

  const { rows, count } = await AuditLog.findAndCountAll({
    where,
    // 次序键加 id：同一微秒内写入的多行（批量操作）也能翻页稳定
    order: [
      ['created_at', 'DESC'],
      ['id', 'DESC'],
    ],
    limit: params.pageSize,
    offset: (params.page - 1) * params.pageSize,
  });

  const emails = await resolveUserEmails(
    tenantId,
    rows.map((r) => r.user_id),
  );

  return {
    logs: rows.map((r) => ({
      id: String(r.id),
      tenant_id: r.tenant_id ?? tenantId,
      user_id: r.user_id,
      user_email: r.user_id === null ? null : (emails.get(r.user_id) ?? null),
      action: r.action,
      resource_type: r.resource_type,
      resource_id: r.resource_id,
      details: r.details ?? null,
      ip: r.ip,
      created_at: r.created_at.toISOString(),
    })),
    pagination: {
      page: params.page,
      page_size: params.pageSize,
      total: count,
      total_pages: Math.ceil(count / params.pageSize),
    },
  };
}

/**
 * 列本租户日志里出现过的所有 action（给「操作类型」筛选下拉框用）
 *
 * 用真实数据而不是硬编码枚举 —— action 是自由字符串（writeAuditLog 不校验），
 * 硬编码一份清单迟早跟实际写入的对不上，筛选框会漏掉新加的操作类型。
 */
export async function listAuditActions(tenantId: string): Promise<string[]> {
  if (typeof tenantId !== 'string' || tenantId === '') {
    return [];
  }
  const rows = await AuditLog.findAll({
    where: { tenant_id: tenantId },
    attributes: ['action'],
    group: ['action'],
    order: [['action', 'ASC']],
  });
  return rows.map((r) => r.action).filter((a): a is string => typeof a === 'string');
}

/**
 * 把 user_id 批量换成邮箱
 *
 * 单独查一次而不是 JOIN users：
 *  - JOIN 遇到「用户已删但日志还在」的行容易在 LEFT JOIN 语义上出错；
 *  - 审计行数可能远大于本页条数，单独查只碰本页出现过的 user_id。
 *
 * 查不到就返回 null（用户被删了 / 是系统账号）—— 日志本身照样要显示。
 */
async function resolveUserEmails(
  tenantId: string,
  userIds: Array<string | null>,
): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter((id): id is string => id !== null && id !== ''))];
  if (ids.length === 0) {
    return new Map();
  }
  const users = await User.findAll({
    where: { id: { [Op.in]: ids }, tenant_id: tenantId },
    attributes: ['id', 'email'],
  });
  const map = new Map<string, string>();
  for (const u of users) {
    map.set(u.id, u.email);
  }
  return map;
}
