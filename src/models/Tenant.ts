import {
  Table,
  Column,
  Model,
  PrimaryKey,
  Default,
  DataType,
  CreatedAt,
  UpdatedAt,
  BeforeCreate,
} from 'sequelize-typescript';
import { nanoid } from 'nanoid';

/**
 * 租户可用的套餐档位
 */
export type TenantPlan = 'free' | 'pro' | 'enterprise';

/**
 * 租户启停状态（F2 配套）
 *  - active    默认；允许 admin/customer 登录
 *  - disabled  被 SaaS 平台方手动禁用，admin/customer 登录一律 401
 *
 * 防自锁：code='system' 的初始租户禁止被改成 disabled（否则 SaaS 平台方自己也登不进）。
 */
export type TenantStatus = 'active' | 'disabled';

/**
 * tenants.settings JSON 列内允许存放的键（运行时会保持 forward-compat，多余键透传）
 *
 * ⚠️ **这个列现在是「保留列」，没有写入路径**（2026-10-25 确认）。
 *
 * 租户级配置的**实际存储**是 `tenant_settings` KV 表（`src/services/tenant-settings.ts`
 * 的 `SETTINGS_REGISTRY` + 通用配置页）—— 迁移 013 已经把原来的
 * `tenant_chat_settings` / `tenant_llm_configs` 搬过去了。
 *
 * 本列只读不写：`src/gateway/system/tenant-routes.ts` 在租户详情里回显它，
 * 其余地方没有任何读取。⚠️ 之前 `src/prompts/index.ts` 的 `resolvePrompt`
 * 还在读它的 `prompt_version` —— 那条链已经拆掉了（读它永远拿到 null）。
 *
 * 保留而不删列：DDL 是共享资产，删列要写迁移 + 处理存量数据，
 * 而它现在无害（永远为 null）。将来真要用这个列做「租户级扩展配置」，
 * 在这里写清楚它的写入方再说。
 */
export interface TenantSettings {
  prompt_version?: string;
  model?: string;
  temperature?: number;
  monthly_token_budget?: number;
  language?: string;
  [key: string]: unknown;
}

/**
 * 租户主表（DDL 见 docs/05-a-数据模型-mysql.md §5.1）
 * - 租户号 `code` 全局唯一，是登录 + 挂件 URL 的入口
 * - `settings` 是**保留列**（见 TenantSettings 的注释）—— 租户级配置走 `tenant_settings` KV 表
 * - `status` / `expires_at`（F2 配套）：任一不满足「active 且未到期」→ admin/customer/login 401
 */
@Table({ tableName: 'tenants' })
export class Tenant extends Model {
  @PrimaryKey
  @Default(() => nanoid(21))
  @Column({ type: DataType.STRING(36) })
  declare id: string;

  @Column({ type: DataType.STRING(32), allowNull: false, unique: true })
  declare code: string;

  @Column({ type: DataType.STRING(200), allowNull: false })
  declare name: string;

  @Default('free')
  @Column({ type: DataType.ENUM('free', 'pro', 'enterprise') })
  declare plan: TenantPlan;

  @Column({ type: DataType.JSON })
  declare settings: TenantSettings | null;

  @Column({ type: DataType.STRING(255) })
  declare api_key_hash: string | null;

  /** F2：租户启停状态。active=正常；disabled=SaaS 平台方手动禁用 */
  @Default('active')
  @Column({ type: DataType.ENUM('active', 'disabled') })
  declare status: TenantStatus;

  /** F2：到期时间。NULL = 永不过期；已到期的租户禁止 admin/customer 登录 */
  @Column({ type: DataType.DATE(6), allowNull: true })
  declare expires_at: Date | null;

  @CreatedAt
  @Column({ type: DataType.DATE(6) })
  declare created_at: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE(6) })
  declare updated_at: Date;

  @BeforeCreate
  static generateId(instance: Tenant): void {
    if (!instance.id) {
      instance.id = nanoid(21);
    }
  }
}
