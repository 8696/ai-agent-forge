import { createHash } from 'node:crypto';

/**
 * 审批键 —— 「工具名 + 入参指纹」
 *
 * 批准必须绑定到**具体那次调用**的参数：
 * 只按工具名批准的话，用户点了「确认提交 200 元」，
 * 紧接着模型改成提交 5000 元也会被放行。
 *
 * 抽成独立模块是因为**两边都要用**：
 *  - `src/tools/execute.ts` —— 闸门算键、比对键
 *  - `src/workflows/engine.ts` —— 工作流闸门算键、比对键
 *  - `src/services/tool-approvals.ts` —— 批准 / 拒绝时算键
 *
 * ⚠️ 放独立文件是为了断开循环依赖：execute.ts 要用引擎，
 *    引擎要用 approvalKey —— 都在一个文件里就会成环。
 */

/**
 * 稳定的 JSON 序列化 —— 键排序，保证同样的入参永远得到同样的指纹
 * （模型的入参键顺序不固定，直接 JSON.stringify 会让指纹飘）
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** 入参指纹 —— 批准记录的键的一部分 */
export function hashArgs(args: unknown): string {
  return createHash('sha256').update(stableStringify(args)).digest('hex').slice(0, 16);
}

/** 敏感工具的批准键：`工具名:入参指纹` */
export function approvalKey(toolName: string, args: unknown): string {
  return `${toolName}:${hashArgs(args)}`;
}
