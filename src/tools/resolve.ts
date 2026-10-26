import { listEnabledTools } from '../services/tools';
import { getBuiltinTool, type BuiltinTool } from './builtin/registry';
import { createHttpToolImpl } from './http-mock';

/**
 * 把「数据库里的注册」解析成「可以交给模型的工具」。
 *
 * 两层：
 *  - 数据库 `tools` 表 —— 租户的注册（调用名 + 描述 + 启停 + 敏感标记）
 *  - 代码 `src/tools/builtin/registry.ts` —— 实现（入参 schema + execute）
 *
 * ## 三个过滤
 *
 *  1. **只取本租户启用的** —— `listEnabledTools` 里有 tenant_id + enabled 过滤
 *  2. **实现必须存在** —— 注册了一条指向已下架实现的记录，跳过（而不是让模型调一个死工具）
 *  3. **描述用租户改过的** —— 租户没改就用内置实现的默认描述
 *
 * ⚠️ 跨租户隔离在这里是第一道闸：`tenant_id` 来自 JWT，
 *    别的租户注册的工具**永远不会**出现在本租户对话的 tool 列表里。
 */
export interface ResolvedTool {
  /** 注册名 —— 模型调用的就是这个名字 */
  name: string;
  /** 给模型看的描述 */
  description: string;
  /** 实现 */
  impl: BuiltinTool;
  /** 是否敏感（要用户确认） */
  requiresConfirmation: boolean;
}

export async function resolveTenantTools(tenantId: string): Promise<ResolvedTool[]> {
  const rows = await listEnabledTools(tenantId);
  const resolved: ResolvedTool[] = [];

  for (const row of rows) {
    // ---- http 类型：本地 mock 实现（配置形状保留，不真出网）----
    //
    // ⚠️ 这里**不能走 `config.builtin`** —— http 工具没有内置实现，
    //    它的实现要按这一行的 config 动态造（入参 schema 来自租户声明的字段）。
    if (row.type === 'http') {
      const impl = createHttpToolImpl(row.config ?? {}, row.name);
      if (impl === null) {
        // 配置不合法（没 url / method 不认识）—— 跳过，别让模型调一个必然失败的工具
        continue;
      }
      resolved.push({
        name: row.name,
        description: (row.description ?? '').trim() || impl.description,
        impl,
        requiresConfirmation: row.requires_confirmation,
      });
      continue;
    }

    const builtinKey = row.config?.builtin;
    if (typeof builtinKey !== 'string') {
      continue;
    }
    const impl = getBuiltinTool(builtinKey);
    if (impl === undefined) {
      // 注册了但实现已下架 —— 跳过，别让模型调一个必然失败的工具
      continue;
    }
    resolved.push({
      name: row.name,
      description: (row.description ?? '').trim() || impl.description,
      impl,
      requiresConfirmation: row.requires_confirmation,
    });
  }

  return resolved;
}
