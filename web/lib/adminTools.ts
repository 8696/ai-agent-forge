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

/** 工具类型。本轮只有 builtin 可执行（http / mcp 的出网策略还没定） */
export type ToolType = 'builtin' | 'http' | 'mcp';

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

export interface SaveToolInput {
  name: string;
  description?: string | undefined;
  type?: ToolType | undefined;
  builtin?: string | undefined;
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
