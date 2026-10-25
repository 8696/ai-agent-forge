import type { z } from 'zod';

/**
 * 内置工具的通用形状 —— 详见 docs/12-b-需求-ai对话能力.md §B3
 *
 * **实现放代码，注册放数据库。** 每个内置工具在这里定义一份「实现」：
 * 入参 schema + 执行函数 + 默认名称/描述 + 试连用的样例入参。
 * 租户在 `/admin/tools` 注册时引用 `key`，并可以**改名称和描述**
 * —— 描述直接决定模型调不调它，所以这是租户唯一能「调教模型」的手柄。
 */
export interface BuiltinToolContext {
  /** 租户 id —— 一律从 JWT 取，绝不信任工具入参 */
  tenantId: string;
  /** 触发的会话（匿名挂件 / 对外 API 时可能为 null） */
  sessionId: string | null;
  /** 触发者 user id（匿名时为 null） */
  userId: string | null;
}

export interface BuiltinTool {
  /** 实现 key —— `tools.config.builtin` 里存的就是它 */
  key: string;
  /** 默认名称（租户注册时的默认值，租户可以改） */
  name: string;
  /** 默认描述 —— **给模型看**，租户可以改 */
  description: string;
  /**
   * 入参 schema。
   *
   * ⚠️ **字段名是 `inputSchema`，不是 `parameters`** —— `docs/07-b` 模块 05 写的
   * `parameters` 是 AI SDK v1 的写法，已装的 v7 用 `inputSchema`。
   */
  inputSchema: z.ZodType;
  /** 执行。抛错会被上层降级成 tool result 回灌，不中断整轮 */
  execute(ctx: BuiltinToolContext, args: unknown): Promise<unknown>;
  /** 试连用的样例入参（`POST /admin/tools/:id/test` 用它） */
  sampleArgs: unknown;
  /** 是否敏感操作 —— true 时模型调用它要先让用户确认 */
  sensitive: boolean;
}
