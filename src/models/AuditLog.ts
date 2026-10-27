import { Table, Column, Model, PrimaryKey, DataType, CreatedAt } from 'sequelize-typescript';

/**
 * 操作类型枚举（F2 引入 + D5 扩充）
 *  - TENANT_STATUS_CHANGE      F2：租户 status 被 SaaS 平台方改成 active/disabled
 *  - TENANT_EXPIRES_CHANGE     F2：租户 expires_at 被 SaaS 平台方改写（包括清空）
 *  - RATE_LIMIT_EXCEEDED       D5：请求被限流拦下（429）
 *  - PROMPT_INJECTION_BLOCKED  D4：输入被注入检测拦下（403）
 *  - CONTENT_MODERATION_BLOCKED D4：输入 / 输出被内容审核拦下（403）
 *  - COST_BUDGET_EXCEEDED      D3：租户本月 token 用量超阈值（告警）
 *  - EVALUATION_SCORE_DROPPED  D1：评测分数较上次下跌超过阈值（告警）
 *  - EVALUATION_DATASET_CREATED / _DELETED / EVALUATION_RUN_STARTED  D1：评测操作留痕
 *
 * 写入时不强校验（writeAuditLog 的 action 收 string），加类型只是给调用处
 * 一个提示 —— 不想因为漏改联合类型就编译不过。
 */
/**
 * 审计动作类型
 *
 * ⚠️ **这一份要跟代码里实际写进 audit_logs 的 action 对齐**。
 *    落库时 `action` 是普通字符串（`writeAuditLog` 收 `AuditAction | string`），
 *    写错了类型也拦不住 —— 所以这个联合类型是**给人看的清单**，不是运行时校验。
 *    加新的写审计的地方时，记得两处都改：
 *      1. 这里（后端）
 *      2. web/pages/admin/AuditLogsPage.tsx 的 ACTION_LABEL（前端中文标签）
 */
export type AuditAction =
  // —— 平台方（system 子系统，tenant_id 为 NULL）——
  | 'TENANT_CREATED'
  | 'TENANT_UPDATED'
  | 'TENANT_ADMIN_PASSWORD_RESET'
  | 'TENANT_STATUS_CHANGE'
  | 'TENANT_EXPIRES_CHANGE'
  // —— 租户后台：用户 ——
  | 'USER_CREATED'
  | 'USER_UPDATED'
  | 'USER_DELETED'
  // —— 租户后台：知识库 ——
  | 'DOCUMENT_UPLOAD'
  | 'DOCUMENT_DELETE'
  | 'DOCUMENT_INDEX_FAILED'
  // —— 租户后台：知识库切片编辑（人工改过知识库内容，得能查出是谁改的）——
  | 'DOCUMENT_CHUNK_EDITED'
  | 'DOCUMENT_CHUNK_SPLIT'
  | 'DOCUMENT_CHUNK_MERGED'
  | 'DOCUMENT_CHUNK_RESET'
  // —— 租户后台：模型 / 提示词 / 设置 ——
  | 'TENANT_MODEL_CREATE'
  | 'TENANT_MODEL_UPDATE'
  | 'TENANT_MODEL_ACTIVATE'
  | 'TENANT_MODEL_DELETE'
  | 'PROMPT_VERSION_CREATE'
  | 'PROMPT_VERSION_DELETE'
  | 'PROMPT_PUBLISH'
  | 'PROMPT_ROLLBACK'
  | 'TENANT_SETTINGS_CHANGE'
  // —— 租户后台：对外 API 密钥 ——
  | 'API_KEY_CREATED'
  | 'API_KEY_REVOKED'
  | 'API_KEY_SCOPE_CHANGED'
  // —— 租户后台：工具（C2 工具管理 / B3 工具调用）——
  | 'TOOL_CREATED'
  | 'TOOL_UPDATED'
  | 'TOOL_ENABLED'
  | 'TOOL_DISABLED'
  | 'TOOL_DELETED'
  // —— 租户后台：评测 ——
  | 'EVALUATION_DATASET_CREATED'
  | 'EVALUATION_DATASET_DELETED'
  | 'EVALUATION_RUN_STARTED'
  | 'EVALUATION_SCORE_DROPPED'
  // —— 租户后台：长期记忆（B4）——
  | 'USER_MEMORY_CREATED'
  | 'USER_MEMORY_UPDATED'
  | 'USER_MEMORY_ARCHIVED'
  | 'USER_MEMORY_RESTORED'
  /** 历史值（早期只有管理员端物理删时用过），保留兼容 */
  | 'USER_MEMORY_DELETED'
  /** 物理删除（不可恢复）：用户自己清空 / 管理员清理 */
  | 'USER_MEMORY_PURGED'
  | 'USER_MEMORY_CLEARED'
  | 'USER_MEMORY_TOGGLED'
  | 'USER_MEMORY_EXTRACTED'
  // —— 账号安全（A4 · 自助改密）——
  | 'PASSWORD_CHANGED'
  // —— 平台级信号（限流 / 安全 / 成本）——
  | 'RATE_LIMIT_EXCEEDED'
  | 'PROMPT_INJECTION_BLOCKED'
  | 'CONTENT_MODERATION_BLOCKED'
  | 'COST_BUDGET_EXCEEDED';

/**
 * 审计日志表 —— 详见 docs/05-a-数据模型-mysql.md §5.1
 *
 * 系统级日志（`tenant_id IS NULL`）表示不属于任何租户的操作，例如：
 *  - SaaS 平台方在 system 子系统里的所有写操作（F2 的 TENANT_*_CHANGE 即此类）
 *  - 登录失败 / 限流命中 / 配置变更等（Step 12 扩充）
 *
 * 注意：本表在 F2（Step 15）首次落地；D5 完整审计由 Step 12 全量上线。
 *
 * 主键 BIGINT AUTO_INCREMENT（见迁移 006）—— 不要在模型上挂 @Default，
 * 否则类型对不上 autoIncrement，sync 时会和数据库冲突。
 *
 * `timestamps: false` 关掉 createdAt / updatedAt 自动维护 —— 审计日志 append-only，
 * 不会有 UPDATE，D5 字段只有 created_at，不要 updated_at（spec 见 05-a §5.1）。
 */
@Table({ tableName: 'audit_logs', timestamps: false })
export class AuditLog extends Model {
  /** 自增 BIGINT 主键（D5 字段，注释同 §5.1） */
  @PrimaryKey
  @Column({ type: DataType.BIGINT, autoIncrement: true })
  declare id: number;

  /**
   * 所属租户。系统级日志（system 子系统操作）= NULL。
   * 不加外键，方便跨子系统查。
   */
  @Column({ type: DataType.STRING(36), allowNull: true })
  declare tenant_id: string | null;

  /** 触发操作的用户 ID；system 操作取 system_user.id */
  @Column({ type: DataType.STRING(36), allowNull: true })
  declare user_id: string | null;

  /** 操作类型（与 AuditAction 对齐；写入时不强校验，方便以后扩展） */
  @Column({ type: DataType.STRING(100), allowNull: false })
  declare action: string;

  /** 资源类型（'user' / 'document' / 'settings' / 'tenant' ...） */
  @Column({ type: DataType.STRING(100), allowNull: true })
  declare resource_type: string | null;

  /** 资源 ID */
  @Column({ type: DataType.STRING(36), allowNull: true })
  declare resource_id: string | null;

  /** 操作详情（JSON；改了什么前后值等） */
  @Column({ type: DataType.JSON, allowNull: true })
  declare details: unknown;

  /** 客户端 IP（IPv6 最长 45 字符） */
  @Column({ type: DataType.STRING(45), allowNull: true })
  declare ip: string | null;

  @CreatedAt
  @Column({ type: DataType.DATE(6) })
  declare created_at: Date;
}
