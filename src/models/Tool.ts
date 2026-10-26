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
  ForeignKey,
  Index,
} from 'sequelize-typescript';
import { nanoid } from 'nanoid';
import { Tenant } from './Tenant';

/**
 * 工具注册表（DDL 见 docs/05-a-数据模型-mysql.md §工具注册表）
 *
 * **实现放代码，注册放数据库。** 这一行是「租户的一次注册」：
 *  - `name` —— 模型看到的调用名（英文短横线风格）
 *  - `description` —— **模型看到的描述，决定它调不调这个工具**
 *    （所以租户能改描述 = 租户能调教模型，这是 C2 真正的价值）
 *  - `config.builtin` —— 指向代码里的实现（`src/tools/builtin/registry.ts`）
 *  - `enabled` —— 关掉后下一轮对话的 tool 列表里就不含它
 *
 * 为什么描述存在库里而不是代码里：描述是**给模型看的提示词**，
 * 同一个内置工具，餐饮租户该写「查这个门店的订单」，物流租户该写「查运单轨迹」。
 * 写死在代码里就得发版才能改。
 *
 * `type` 三类：
 *  - `builtin` —— 平台内置实现
 *  - `http` —— 租户自己的 REST 接口（**本地 mock 版**：配置形状保留，但不真出网）
 *  - `mcp` —— 外部 MCP 服务（**已明确不做**：跨系统，租户那边得自己跑 MCP server）
 *
 * `requires_confirmation`：敏感工具。模型调用它时**不直接执行**，
 * 先要用户点确认（docs/12-b §B5 HITL 的最小实现；完整状态机留给 missions 表）。
 */
export type ToolType = 'builtin' | 'http' | 'mcp';

export const TOOL_TYPES: readonly ToolType[] = ['builtin', 'http', 'mcp'];

/**
 * 本轮可执行的类型。
 *
 * ⚠️ **`mcp` 不在里面** —— 用户 2026-10-26 拍板：MCP 涉及多个系统
 * （租户那边得自己跑一个 MCP server），「当前一个系统做完」做不到。
 * 见 [12-e 需求裁定表](./12-e-需求-业务接入与平台运营.md) #1。
 *
 * ⚠️ **`http` 在里面，但它是「本地 mock」** —— 保留「租户配 url/method」的形状，
 * 平台**不真的发请求**，按 `(租户, url, method, 入参)` 确定性生成响应。
 * 见 12-e 需求裁定表 #2。
 */
export const EXECUTABLE_TOOL_TYPES: readonly ToolType[] = ['builtin', 'http'];

/**
 * `tools.config` JSON 列的形状。
 *
 *  - `builtin` 类型：`{ builtin: 'query_order_status' }` —— 指向代码里的实现 key
 *  - `http` 类型：`{ url, method, mock_response?, mock_status?, input_fields? }`
 *    —— **本地 mock**，不真出网（字段定义见 `src/tools/http-mock.ts`）
 *
 * 运行时不做校验，多余键透传 —— 跟 documents.metadata 同一个约定。
 */
export interface ToolConfig {
  /** 内置实现的 key（type='builtin' 时必填） */
  builtin?: string;
  /** http 工具的目标地址（type='http' 时）—— **只做展示与 mock 依据，不真出网** */
  url?: string;
  /** http 工具的方法（type='http' 时） */
  method?: string;
  /** http 工具的模拟响应原文（type='http' 时，租户填了就用它） */
  mock_response?: unknown;
  /** http 工具的模拟状态码（type='http' 时，默认 200；非 2xx 走「调不通」降级） */
  mock_status?: number;
  /** http 工具的入参字段声明（type='http' 时） */
  input_fields?: unknown;
  [key: string]: unknown;
}

@Table({ tableName: 'tools' })
export class Tool extends Model {
  @PrimaryKey
  @Default(() => nanoid(21))
  @Column({ type: DataType.STRING(36) })
  declare id: string;

  @ForeignKey(() => Tenant)
  @Index({ name: 'idx_tools_tenant' })
  @Column({ type: DataType.STRING(36), allowNull: false })
  declare tenant_id: string;

  /** 工具名（英文，模型调用时用的就是这个名字） */
  @Column({ type: DataType.STRING(100), allowNull: false })
  declare name: string;

  /** 工具描述 —— **给 LLM 看**，决定它调不调这个工具 */
  @Column({ type: DataType.TEXT('medium'), allowNull: true })
  declare description: string | null;

  @Default('builtin')
  @Column({
    type: DataType.ENUM('builtin', 'http', 'mcp'),
    allowNull: false,
    defaultValue: 'builtin',
  })
  declare type: ToolType;

  /** 配置（内置装实现 key；http/mcp 装端点与鉴权） */
  @Column({ type: DataType.JSON, allowNull: true })
  declare config: ToolConfig | null;

  /** 是否启用 —— 关掉后下一轮对话的 tool 列表里就不含它 */
  @Default(true)
  @Column({ type: DataType.BOOLEAN, allowNull: false })
  declare enabled: boolean;

  /**
   * 是否敏感操作。true 时模型调用它**不会直接执行**，
   * 先要用户在对话里点确认（docs/12-b §B5 HITL 的最小实现）。
   */
  @Default(false)
  @Column({ type: DataType.BOOLEAN, allowNull: false })
  declare requires_confirmation: boolean;

  /** 注册人（租户 admin 的 user id） */
  @Column({ type: DataType.STRING(36), allowNull: true })
  declare created_by: string | null;

  /** 最后修改人（租户 admin 的 user id） */
  @Column({ type: DataType.STRING(36), allowNull: true })
  declare updated_by: string | null;

  @CreatedAt
  @Column({ type: DataType.DATE(6) })
  declare created_at: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE(6) })
  declare updated_at: Date;

  @BeforeCreate
  static generateId(instance: Tool): void {
    if (!instance.id) {
      instance.id = nanoid(21);
    }
  }
}
