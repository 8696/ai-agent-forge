import { Tool, type ToolConfig, type ToolType } from '../models';
import { NotFoundError, ValidationError } from '../lib/errors';
import { EXECUTABLE_TOOL_TYPES } from '../models/Tool';
import { getBuiltinTool } from '../tools/builtin/registry';
import { HTTP_METHODS } from '../tools/http-mock';
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
  /** http 工具的目标地址（type='http' 时）—— **只做展示，平台不真出网** */
  url: string | null;
  /** http 工具的方法（type='http' 时） */
  method: string | null;
  /** http 工具是不是本地 mock（永远是 true —— 真出网已明确不做） */
  mocked: boolean;
  enabled: boolean;
  requires_confirmation: boolean;
  created_at: string;
  updated_at: string;
}

export function toToolView(row: Tool): ToolView {
  const isHttp = row.type === 'http';
  const builtinKey = row.config?.builtin;
  const impl = typeof builtinKey === 'string' ? getBuiltinTool(builtinKey) : undefined;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    type: row.type,
    builtin: impl === undefined ? null : impl.key,
    builtin_label: impl === undefined ? null : impl.name,
    url: isHttp && typeof row.config?.url === 'string' ? row.config.url : null,
    method: isHttp && typeof row.config?.method === 'string' ? row.config.method : null,
    mocked: isHttp,
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
  /** 工具类型：`builtin`（内置实现）/ `http`（本地 mock 接口）/ `mcp`（**不做**） */
  type: ToolType;
  /** 内置实现 key（type='builtin' 时必填） */
  builtin?: string | undefined;
  /** http 工具的目标地址（type='http' 时必填）—— **只做展示与 mock 依据，不真出网** */
  url?: string | undefined;
  /** http 工具的方法（type='http' 时，默认 GET） */
  method?: string | undefined;
  /** http 工具的模拟响应原文（type='http' 时；填了就用它，不填则平台确定性生成） */
  mock_response?: unknown;
  /** http 工具的模拟状态码（type='http' 时，默认 200） */
  mock_status?: number | undefined;
  /** http 工具的入参字段声明（type='http' 时） */
  input_fields?: unknown;
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
 *  - `mcp` **不做**（跨系统：租户那边得自己跑 MCP server）—— 见 12-e 需求裁定表 #1
 *  - `http` **是本地 mock**：url / method 保留配置形状，但平台不真的发请求
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
      input.type === 'mcp'
        ? 'MCP 类型不做：它涉及多个系统（租户那边得自己跑一个 MCP server），本平台只做「当前一个系统能闭环」的事。' +
          '目前支持 builtin（内置实现）和 http（本地 mock 接口）。'
        : `工具类型 ${input.type} 不支持。目前支持 builtin（内置实现）和 http（本地 mock 接口）。`,
    );
  }

  const description = (input.description ?? '').trim();

  // ---- http 类型：本地 mock，不真出网 ----
  if (input.type === 'http') {
    const url = (input.url ?? '').trim();
    if (url === '') {
      throw new ValidationError('http 类型工具必须填目标地址（url）');
    }
    if (!/^https?:\/\/[^\s]+$/i.test(url)) {
      throw new ValidationError('目标地址格式不对（要 http:// 或 https:// 开头，例如 https://api.example.com/orders/{id}）');
    }
    const method = (input.method ?? 'GET').trim().toUpperCase();
    if (!(HTTP_METHODS as readonly string[]).includes(method)) {
      throw new ValidationError(`不支持的 HTTP 方法：${method}（支持 ${HTTP_METHODS.join(' / ')}）`);
    }
    const mockStatus = input.mock_status ?? 200;
    if (!Number.isInteger(mockStatus) || mockStatus < 100 || mockStatus > 599) {
      throw new ValidationError('模拟状态码不合法（100~599 的整数）');
    }

    // config 里不放 undefined —— JSON 列会丢，但显式剔除更干净
    const config: ToolConfig = { url, method, mock_status: mockStatus };
    if (input.mock_response !== undefined) {
      config.mock_response = input.mock_response;
    }
    if (input.input_fields !== undefined) {
      config.input_fields = input.input_fields;
    }

    return {
      name,
      description:
        description === ''
          ? `调用 ${method} ${url} 拿到数据。本工具是本地 mock，不会真的向该地址发请求。`
          : description,
      type: 'http',
      config,
      enabled: input.enabled ?? true,
      // http 工具默认不敏感 —— 它是读操作；租户可以自己勾上「要确认」
      requires_confirmation: input.requires_confirmation ?? false,
    };
  }

  const builtin = input.builtin ?? '';
  const impl = getBuiltinTool(builtin);
  if (impl === undefined) {
    throw new ValidationError('内置实现不存在或已下架，请从下拉框里选一个');
  }

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
  // http 工具的接口配置**可以改** —— url / method 不是模型的调用名，
  // 改了不影响模型的历史认知（改的只是「这个 mock 返回什么」）
  if (row.type === 'http') {
    const config: ToolConfig = { ...(row.config ?? {}) };
    if (input.url !== undefined) {
      const url = input.url.trim();
      if (url === '' || !/^https?:\/\/[^\s]+$/i.test(url)) {
        throw new ValidationError('目标地址格式不对（要 http:// 或 https:// 开头）');
      }
      config.url = url;
    }
    if (input.method !== undefined) {
      const method = input.method.trim().toUpperCase();
      if (!(HTTP_METHODS as readonly string[]).includes(method)) {
        throw new ValidationError(`不支持的 HTTP 方法：${method}`);
      }
      config.method = method;
    }
    if (input.mock_response !== undefined) {
      config.mock_response = input.mock_response;
    }
    if (input.mock_status !== undefined) {
      if (!Number.isInteger(input.mock_status) || input.mock_status < 100 || input.mock_status > 599) {
        throw new ValidationError('模拟状态码不合法（100~599 的整数）');
      }
      config.mock_status = input.mock_status;
    }
    if (input.input_fields !== undefined) {
      config.input_fields = input.input_fields;
    }
    row.config = config;
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
