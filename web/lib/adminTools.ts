import { adminApi } from './adminApi';
import { apiErrorMessage } from './apiError';

/**
 * 租户工具管理 —— C2（docs/12-c-需求-管理员可配置.md §C2）
 *
 * 对应 src/gateway/admin/tool-routes.ts（路由前缀 /api/v1/admin/tools）。
 *
 * ## 「实现放代码，注册放数据库」
 *
 * 平台内置的工具实现在代码里（`src/tools/builtin/registry.ts`），
 * 租户在后台做的是**注册**：给它起个调用名、写一段描述、决定用不用。
 *
 * **描述是给模型看的** —— 它直接决定模型调不调这个工具。
 * 所以「改描述」是这个页面最值钱的功能：同一个内置工具，
 * 餐饮租户该写「查这个门店的订单」，物流租户该写「查运单轨迹」。
 */

/**
 * 工具类型。
 *
 * ⚠️ **`mcp` 不开放** —— 涉及多个系统（租户那边得自己跑 MCP server），
 *    「当前一个系统做完」做不到。见 12-e 需求裁定表 #1。
 * ⚠️ **`http` 是「本地 mock」** —— 保留 url/method 的配置形状，
 *    但平台**不真的发请求**。见 12-e 需求裁定表 #2。
 */
export type ToolType = 'builtin' | 'http';

export interface ToolItem {
  id: string;
  /** 调用名（模型调用的就是这个名字） */
  name: string;
  /** 给模型看的描述 */
  description: string | null;
  type: ToolType;
  /** 内置实现的 key */
  builtin: string | null;
  /** 内置工具的中文名（展示用） */
  builtin_label: string | null;
  /** http 工具的目标地址（**只做展示，平台不真出网**） */
  url: string | null;
  /** http 工具的方法 */
  method: string | null;
  /** 是不是本地 mock（http 类型永远是 true） */
  mocked: boolean;
  enabled: boolean;
  /** 是否敏感操作（要用户确认才执行） */
  requires_confirmation: boolean;
  created_at: string;
  updated_at: string;
}

/** 平台内置工具的元信息（注册时的下拉框） */
export interface BuiltinToolInfo {
  key: string;
  name: string;
  description: string;
  sensitive: boolean;
  sample_args: unknown;
}

/** http 工具的入参字段声明（后台填，平台据此生成校验 schema） */
export interface HttpInputField {
  name: string;
  type: 'string' | 'number' | 'boolean';
  required?: boolean;
  description?: string;
}

export interface SaveToolInput {
  name: string;
  description?: string | undefined;
  type?: ToolType | undefined;
  builtin?: string | undefined;
  /** http 工具的目标地址 */
  url?: string | undefined;
  /** http 工具的方法 */
  method?: string | undefined;
  /** http 工具的模拟响应原文（JSON 文本） */
  mock_response?: unknown;
  /** http 工具的模拟状态码 */
  mock_status?: number | undefined;
  /** http 工具的入参字段声明 */
  input_fields?: HttpInputField[] | undefined;
  enabled?: boolean | undefined;
  requires_confirmation?: boolean | undefined;
}

export interface ToolTestResult {
  ok: boolean;
  output?: unknown;
  error?: string;
  took_ms: number;
  timeout_ms: number;
}

export async function fetchTools(): Promise<ToolItem[]> {
  const { data } = await adminApi.get<{ tools: ToolItem[] }>('/tools');
  return data.tools;
}

export async function fetchBuiltinTools(): Promise<BuiltinToolInfo[]> {
  const { data } = await adminApi.get<{ builtins: BuiltinToolInfo[] }>('/tools/builtins');
  return data.builtins;
}

export async function createTool(input: SaveToolInput): Promise<ToolItem> {
  const { data } = await adminApi.post<{ tool: ToolItem }>('/tools', input);
  return data.tool;
}

export async function updateTool(
  id: string,
  input: Partial<SaveToolInput>,
): Promise<ToolItem> {
  const { data } = await adminApi.patch<{ tool: ToolItem }>(
    `/tools/${encodeURIComponent(id)}`,
    input,
  );
  return data.tool;
}

export async function deleteTool(id: string): Promise<void> {
  await adminApi.delete(`/tools/${encodeURIComponent(id)}`);
}

/** 试连一次 —— 用内置实现的样例入参真跑一遍 */
export async function testTool(id: string, args?: unknown): Promise<ToolTestResult> {
  const { data } = await adminApi.post<ToolTestResult>(
    `/tools/${encodeURIComponent(id)}/test`,
    args === undefined ? {} : { args },
    { timeout: 60_000 },
  );
  return data;
}

/** 把后端的错误信息挖出来给人看（跟 adminConfig.ts 的同名函数一个套路） */
export function toolErrorMessage(err: unknown, fallback: string): string {
  return apiErrorMessage(err, fallback);
}
