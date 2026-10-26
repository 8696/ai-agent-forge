import { z } from 'zod';
import type { BuiltinTool, BuiltinToolContext } from './builtin/types';
import { pickDate, pickSerial } from './builtin/mock';

/**
 * `http` 类型的工具 —— **本地 mock，不真出网**（docs/12-e 需求裁定表 #2 / #3）
 *
 * ## 为什么是 mock 而不是真的调租户的接口
 *
 * 1. **跨系统**：真出网意味着平台方要打到**租户自己的服务器**上 ——
 *    那是另一个系统，不在「当前一个系统做完」的范围里（用户 2026-10-26 拍板）
 * 2. **出网策略没定**：照抄 LLM Base URL 那套「生产禁私网」的 SSRF 闸会把正当用途全挡掉
 *    （`http` 工具的正常用法恰恰就是调租户内网系统）
 * 3. **没有真实的副作用可跟踪**：真接了外部系统，B5 的状态机才有真实的「会动数据」的场景 ——
 *    但那要求租户先有系统，这条路先不通
 *
 * ## 它保留了什么
 *
 * **配置的形状不变** —— 租户照样填 `url` / `method` / 入参字段，
 * 后台照样展示「这个工具指向哪个接口」。区别只有一个：**平台不真的发请求**，
 * 而是按 `(租户, url, method, 入参)` **确定性**地生成一份响应。
 *
 * 确定性很重要：同一个租户、同一个调用，两次得到一样的结果 ——
 * 否则用户问两次得到两个答案，会以为系统不稳定。
 *
 * ## 租户能不能自己指定响应
 *
 * 能：`config.mock_response` 填一份 JSON 就是响应原文（完全可控），
 * `config.mock_status` 填状态码（默认 200）。**填了非 2xx 就按「调不通」降级**
 * （跟 B3 的验收口径一致：工具失败不中断整轮，降级成 tool result 回灌）。
 */

/** `http` 工具在 `config` 里用的伪 builtin key —— 只用于标记类型，不是真的内置实现 */
export const HTTP_MOCK_KEY = 'http_mock';

/** 入参字段声明 —— 租户在后台填，平台据此生成校验 schema */
export interface HttpInputField {
  /** 参数名 */
  name: string;
  /** 参数类型 */
  type: 'string' | 'number' | 'boolean';
  /** 是否必填 */
  required?: boolean;
  /** 给模型看的说明 */
  description?: string;
}

/** `config` 里 http 工具用到的字段 */
export interface HttpToolConfig {
  /** 目标地址 —— **只做展示与 mock 依据，不会真的出网** */
  url?: string | undefined;
  /** 方法 */
  method?: string | undefined;
  /** 租户写死的响应（不填则平台确定性生成） */
  mock_response?: unknown;
  /** 模拟的 HTTP 状态码（默认 200）；非 2xx 走「调不通」降级 */
  mock_status?: number | undefined;
  /**
   * 入参字段声明。
   *
   * ⚠️ 类型是 `unknown` 而不是 `HttpInputField[]` —— **config 是 JSON 列，
   * 里面存的东西是租户填的、不可信的**。真正的校验在 `buildHttpInputSchema`
   * 里做（逐条挑出合法的字段声明，脏数据丢掉而不是崩掉）。
   */
  input_fields?: unknown;
}

/** 平台支持的 HTTP 方法 */
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * 从不可信的 config 里挑出**合法**的字段声明。
 *
 * ⚠️ config 是 JSON 列，租户填的东西什么都可能有 —— 这里逐条挑，
 *    脏数据**丢掉**而不是让整个工具崩掉（一个字段写错不该让工具调不通）。
 */
function sanitizeFields(raw: unknown): HttpInputField[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: HttpInputField[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const rec = item as Record<string, unknown>;
    const name = typeof rec.name === 'string' ? rec.name.trim() : '';
    if (name === '' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      continue;
    }
    const type = rec.type;
    if (type !== 'string' && type !== 'number' && type !== 'boolean') {
      continue;
    }
    out.push({
      name,
      type,
      required: rec.required === true,
      ...(typeof rec.description === 'string' ? { description: rec.description.slice(0, 200) } : {}),
    });
  }
  return out;
}

/**
 * 按租户声明的字段生成 zod schema。
 *
 * **空声明 → 自由对象**（`passthrough`）：模型传什么就收什么，
 * 不因为租户没配字段就拒掉整个调用。
 */
export function buildHttpInputSchema(fields: unknown): z.ZodType {
  const list = sanitizeFields(fields);
  if (list.length === 0) {
    return z.object({}).passthrough();
  }
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of list) {
    let base: z.ZodTypeAny;
    if (field.type === 'number') {
      base = z.number();
    } else if (field.type === 'boolean') {
      base = z.boolean();
    } else {
      base = z.string().min(1, `${field.name} 不能为空`);
    }
    const withDesc = field.description === undefined ? base : base.describe(field.description);
    shape[field.name] = field.required === true ? withDesc : withDesc.optional();
  }
  return z.object(shape).passthrough();
}

/** 生成的默认响应体 —— 确定性的 */
function defaultPayload(tenantId: string, url: string, method: string, args: unknown): unknown {
  const key = `http:${method}:${url}`;
  return {
    id: pickSerial(tenantId, `${key}:id`, 'REC'),
    // 回显入参 —— 让模型能把「我问了什么」和「拿到什么」对上
    query: args,
    updated_at: `${pickDate(tenantId, `${key}:at`, 30, 0)} 12:00`,
  };
}

/**
 * 造一个 `http` 工具的实现（形状跟内置工具一样，能直接进 `buildToolSet`）。
 *
 * `config` 不合法（没 url / method 不认识）时返回 null —— 调用方跳过，
 * 免得出现「注册了但永远调不通」的死条目。
 */
export function createHttpToolImpl(
  config: HttpToolConfig,
  toolName: string,
): BuiltinTool | null {
  const url = (config.url ?? '').trim();
  const method = (config.method ?? 'GET').trim().toUpperCase();
  if (url === '') {
    return null;
  }
  if (!(HTTP_METHODS as readonly string[]).includes(method)) {
    return null;
  }
  const status = config.mock_status ?? 200;
  const schema = buildHttpInputSchema(config.input_fields);

  return {
    key: HTTP_MOCK_KEY,
    name: `${toolName}（本地 mock 接口）`,
    description:
      `调用 ${method} ${url} 拿到数据。` +
      '本工具是**本地 mock**，不会真的向该地址发请求 —— 返回的是按调用参数确定性生成的模拟响应。',
    inputSchema: schema,
    sampleArgs: {},
    sensitive: false,
    async execute(ctx: BuiltinToolContext, args: unknown) {
      // 非 2xx → 按「调不通」降级（跟 B3 验收：工具失败不中断整轮）
      if (status < 200 || status >= 300) {
        throw new Error(`接口返回 ${status}`);
      }
      const body = config.mock_response ?? defaultPayload(ctx.tenantId, url, method, args);
      return {
        status,
        url,
        method,
        data: body,
        mocked: true,
      };
    },
  };
}
