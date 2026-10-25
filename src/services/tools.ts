import { Tool, type ToolConfig, type ToolType } from '../models';
import { NotFoundError, ValidationError } from '../lib/errors';
import { EXECUTABLE_TOOL_TYPES } from '../models/Tool';
import { getBuiltinTool } from '../tools/builtin/registry';
import { logger } from '../logger';

/**
 * 工具注册表服务 —— docs/12-c §C2（工具管理）+ docs/12-b §B3（工具调用）
 *
 * **实现放代码，注册放数据库**：
 *  - 代码侧 `src/tools/builtin/registry.ts` 定义实现（key + 入参 schema + execute）
 *  - 数据库侧 `tools` 表存租户的注册（调用名 + 描述 + 启停 + 敏感标记）
 *
 * 租户能改的是**描述** —— 它是给模型看的，直接决定模型调不调这个工具。
 * 这是 C2 真正的价值：不是「租户能接自己的系统」，而是「租户能调教模型」。
 *
 * ## 租户隔离
 *
 * `tenant_id` **永远从调用方传入**（路由层从 JWT 取），不接受请求体里的 tenant_id。
 * 本文件里每一条查询都带 `tenant_id` 过滤 —— 这是 A1 的红线，
 * `tests/unit/tenant-isolation-guard.test.ts` 会扫这段代码。
 */

/** 工具调用名（模型调用的就是这个名字）—— 必须是合法标识符 */
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/;

export interface ToolView {
  id: string;
  /** 调用名（模型调用的就是这个名字） */
  name: string;
  /** 给模型看的描述 */
  description: string | null;
  type: ToolType;
  /** 内置实现的 key（type='builtin' 时） */
  builtin: string | null;
  /** 内置工具的中文名（后台列表展示用） */
  builtin_label: string | null;
  enabled: boolean;
  requires_confirmation: boolean;
  created_at: string;
  updated_at: string;
}

export function toToolView(row: Tool): ToolView {
  const builtinKey = row.config?.builtin;
  const impl = typeof builtinKey === 'string' ? getBuiltinTool(builtinKey) : undefined;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    type: row.type,
    builtin: impl === undefined ? null : impl.key,
    builtin_label: impl === undefined ? null : impl.name,
    enabled: row.enabled,
    requires_confirmation: row.requires_confirmation,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export async function listTools(tenantId: string): Promise<ToolView[]> {
  const rows = await Tool.findAll({
    where: { tenant_id: tenantId },
    order: [['created_at', 'DESC']],
  });
  return rows.map(toToolView);
}

/** 对话链路用：本租户**启用中**的工具（禁用 / 未注册的不进 tool 列表） */
export async function listEnabledTools(tenantId: string): Promise<Tool[]> {
  return Tool.findAll({
    where: { tenant_id: tenantId, enabled: true },
    order: [['created_at', 'ASC']],
  });
}

export async function getTool(tenantId: string, id: string): Promise<Tool> {
  const row = await Tool.findOne({ where: { id, tenant_id: tenantId } });
  if (row === null) {
    throw new NotFoundError('工具');
  }
  return row;
}

export interface ToolInput {
  /** 调用名（英文标识符） */
  name: string;
  /** 给模型看的描述 */
  description?: string | undefined;
  /** 本轮只有 builtin 可执行 */
  type: ToolType;
  /** 内置实现 key（type='builtin' 时必填） */
  builtin?: string | undefined;
  /** 是否启用 */
  enabled?: boolean | undefined;
  /** 是否敏感（要用户确认） */
  requires_confirmation?: boolean | undefined;
}

/**
 * 校验并归一化注册入参。
 *
 * 几个硬约束：
 *  - 调用名必须是合法标识符（模型要按这个名字调，中文/空格会调不出来）
 *  - `builtin` 类型必须指向一个**存在的**实现（指向已下架实现 = 注册了条死工具）
 *  - `http` / `mcp` 本轮不开放 —— 它们的出网策略（SSRF）还没定，
 *    先堵住，免得出现「注册了但永远调不通」的死条目
 */
export function normalizeToolInput(input: ToolInput): {
  name: string;
  description: string | null;
  type: ToolType;
  config: ToolConfig;
  enabled: boolean;
  requires_confirmation: boolean;
} {
  const name = input.name.trim();
  if (!TOOL_NAME_PATTERN.test(name)) {
    throw new ValidationError(
      '工具名必须是英文标识符（小写字母开头，只能含小写字母 / 数字 / 下划线 / 短横线，长度 2~64）',
    );
  }

  if (!EXECUTABLE_TOOL_TYPES.includes(input.type)) {
    throw new ValidationError(
      `工具类型 ${input.type} 本轮未开放（出网安全策略还没定）。目前只支持 builtin。`,
    );
  }

  const builtin = input.builtin ?? '';
  const impl = getBuiltinTool(builtin);
  if (impl === undefined) {
    throw new ValidationError('内置实现不存在或已下架，请从下拉框里选一个');
  }

  const description = (input.description ?? '').trim();
  return {
    name,
    description: description === '' ? impl.description : description,
    type: input.type,
    config: { builtin: impl.key },
    enabled: input.enabled ?? true,
    // 敏感工具的默认标记跟内置实现走（提交退款申请这类天生敏感）
    requires_confirmation: input.requires_confirmation ?? impl.sensitive,
  };
}

export async function createTool(
  tenantId: string,
  userId: string,
  input: ToolInput,
): Promise<Tool> {
  const norm = normalizeToolInput(input);
  try {
    return await Tool.create({
      tenant_id: tenantId,
      name: norm.name,
      description: norm.description,
      type: norm.type,
      config: norm.config,
      enabled: norm.enabled,
      requires_confirmation: norm.requires_confirmation,
      created_by: userId,
    });
  } catch (err: unknown) {
    // 工具名租户内唯一（uk_tenant_name）—— 重名转 400 而不是 500
    if (isDuplicateEntry(err)) {
      throw new ValidationError('同名工具已经存在了（工具名在本租户内唯一）');
    }
    throw err;
  }
}

export async function updateTool(
  tenantId: string,
  id: string,
  input: Partial<ToolInput>,
  userId?: string | undefined,
): Promise<Tool> {
  const row = await getTool(tenantId, id);

  // 只改描述 / 启停 / 敏感标记 —— 「实现」和「调用名」注册后不改
  // （改调用名等于换了个工具，模型的历史认知全废）
  if (input.description !== undefined) {
    const description = input.description.trim();
    row.description = description === '' ? null : description;
  }
  if (input.enabled !== undefined) {
    row.enabled = input.enabled;
  }
  if (input.requires_confirmation !== undefined) {
    row.requires_confirmation = input.requires_confirmation;
  }
  // 记一下最后是谁改的（建表时有 created_by，改的人原来没记）
  if (userId !== undefined && userId !== '') {
    row.updated_by = userId;
  }

  await row.save();
  return row;
}

export async function deleteTool(tenantId: string, id: string): Promise<void> {
  const row = await getTool(tenantId, id);
  await row.destroy();
}

/**
 * MySQL 唯一键冲突的识别 —— Sequelize 的 SequelizeUniqueConstraintError
 * 只带原始字段名，不带「哪个索引」，所以按 error name + 消息里有没有工具名兜底。
 */
function isDuplicateEntry(err: unknown): boolean {
  if (err instanceof Error && err.name === 'SequelizeUniqueConstraintError') {
    return true;
  }
  if (err instanceof Error && 'code' in err && (err as { code?: unknown }).code === 'ER_DUP_ENTRY') {
    return true;
  }
  logger.warn({ err }, '工具注册失败（疑似唯一键冲突）');
  return false;
}
