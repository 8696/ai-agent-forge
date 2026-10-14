import { AuditLog, type AuditAction } from '../models';
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
    const err = e as { name?: string; message?: string };
    logger.warn(
      {
        audit: params,
        err: err.message ?? String(e),
        err_name: err.name ?? null,
      },
      'audit log write failed',
    );
  }
}
