/**
 * 预配置的 axios HTTP 客户端 —— docs/12-d §D6 测试基建契约
 *
 * 用法：
 *   import { adminHttp, loginAdmin } from '../helpers';
 *   const http = adminHttp(await loginAdmin('acme'));
 *   const me = await http.get('/me');
 *
 * 401 自动重登：withReauth(http, reLogin) 包一层 → 收到 401 自动调 reLogin 拿新 token 重发。
 */
import axios, { type AxiosInstance } from 'axios';
import {
  loginAdmin,
  loginCustomer,
  loginSystem,
  readTokensFile,
} from './auth';

/**
 * 后端根地址 —— **所有测试文件都必须用这个**，不要各自重算一遍。
 *
 * 优先级：API_BASE（显式指定）> PORT（默认 3099）。
 * ⚠️ 之前每个测试文件都自己写 `http://localhost:${process.env.PORT ?? '3099'}`，
 *    跑在非默认端口时裸 axios 请求会打到 3099 去 → 一片 ECONNREFUSED。
 *    统一从这里取就绕开了。
 */
export function apiBase(): string {
  return process.env.API_BASE ?? `http://localhost:${process.env.PORT ?? '3099'}`;
}

function withAuthHeader(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

export function systemHttp(token: string): AxiosInstance {
  return axios.create({ baseURL: `${apiBase()}/api/v1/system`, headers: withAuthHeader(token) });
}

export function adminHttp(token: string): AxiosInstance {
  return axios.create({ baseURL: `${apiBase()}/api/v1/admin`, headers: withAuthHeader(token) });
}

/** customer 子系统（会话 / 历史 / 流式对话 / 反馈） */
export function customerHttp(token: string): AxiosInstance {
  return axios.create({ baseURL: `${apiBase()}/api/v1/customer`, headers: withAuthHeader(token) });
}

/**
 * 对外 chat API 用 API Key 鉴权（不是 JWT），参考 docs/06 §6.2
 */
export function apiKeyHttp(rawKey: string): AxiosInstance {
  return axios.create({
    baseURL: `${apiBase()}/api/v1`,
    headers: { authorization: `Bearer ${rawKey}` },
  });
}

/**
 * 401 自动重登包装：请求收到 401 → 调 reLogin 拿新 token → 用新 token 重发 1 次
 * 避免 JWT 过期 / 服务重启后 token 失效的中间态失败
 */
export function withReauth(
  http: AxiosInstance,
  reLogin: () => Promise<string>,
): AxiosInstance {
  const wrapped = axios.create(http.defaults);
  wrapped.interceptors.request.use((cfg) => cfg);
  wrapped.interceptors.response.use(
    (r) => r,
    async (err: unknown) => {
      const e = err as { config?: { headers?: Record<string, string> }; response?: { status?: number } };
      if (e?.response?.status !== 401 || e.config === undefined) {
        throw err;
      }
      const fresh = await reLogin();
      const retry = { ...e.config, headers: { ...(e.config.headers ?? {}), authorization: `Bearer ${fresh}` } };
      return axios.request(retry);
    },
  );
  return wrapped;
}

/**
 * 一键拿全套 HTTP 客户端（用 .e2e-tokens.json 的现成 token，0 网络请求）
 * 适合一次性跑多个 API 测试的场景。
 *
 * customer 客户端从 B1 起有了受保护端点（会话 CRUD / 流式对话 / 反馈），
 * 所以也进这套 AllHttp。
 */
export interface AllHttp {
  system: AxiosInstance;
  acmeAdmin: AxiosInstance;
  globAdmin: AxiosInstance;
  acmeCustomer: AxiosInstance;
  globCustomer: AxiosInstance;
  acmeApiKey: AxiosInstance;
  globApiKey: AxiosInstance;
}

export async function allHttpFromTokensFile(): Promise<AllHttp> {
  const t = await readTokensFile();
  return {
    system: systemHttp(t.system),
    acmeAdmin: adminHttp(t.acmeAdmin),
    globAdmin: adminHttp(t.globAdmin),
    acmeCustomer: customerHttp(t.acmeCustomer),
    globCustomer: customerHttp(t.globCustomer),
    acmeApiKey: apiKeyHttp(t.acmeApiKey),
    globApiKey: apiKeyHttp(t.globApiKey),
  };
}

/**
 * 主动重新登录拿一套新 HTTP（处理 JWT 过期 / 服务重启）
 */
export async function allHttpFresh(): Promise<AllHttp> {
  const [system, acmeAdmin, globAdmin, acmeCustomer, globCustomer] = await Promise.all([
    loginSystem(),
    loginAdmin('acme'),
    loginAdmin('globex'),
    loginCustomer('acme'),
    loginCustomer('globex'),
  ]);
  const t = await readTokensFile();
  return {
    system: systemHttp(system),
    acmeAdmin: adminHttp(acmeAdmin),
    globAdmin: adminHttp(globAdmin),
    acmeCustomer: customerHttp(acmeCustomer),
    globCustomer: customerHttp(globCustomer),
    acmeApiKey: apiKeyHttp(t.acmeApiKey),
    globApiKey: apiKeyHttp(t.globApiKey),
  };
}

// ============================================================
// SSE 流式读取（B1 流式对话测试专用）
// ============================================================

/** AI SDK 的 UI message stream chunk（wire 上是 `data: {json}`） */
export interface StreamChunk {
  type: string;
  [k: string]: unknown;
}

export interface StreamResult {
  status: number;
  contentType: string | null;
  headers: Record<string, string>;
  chunks: StreamChunk[];
  /** 原始 SSE 文本，断言 `: stream-open` 心跳注释时用 */
  raw: string;
}

/**
 * 读一条 SSE 流并解析成 chunk 数组。
 *
 * 用 fetch + `res.text()` 一次性读全，而不是 axios 的 responseType: 'stream'：
 * 测试要断言的是**最终状态**（chunk 集合、落库内容），不是逐 token 时序。
 * 先读全再解析最简单，也不会留下半开的 read 泄漏。
 */
export async function readSse(url: string, token: string, body: unknown): Promise<StreamResult> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  const chunks: StreamChunk[] = [];
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ')) {
      continue;
    }
    const payload = line.slice('data: '.length).trim();
    // [DONE] 是结束标记；其余应该都是 JSON chunk
    if (payload === '' || payload === '[DONE]') {
      continue;
    }
    try {
      chunks.push(JSON.parse(payload) as StreamChunk);
    } catch {
      // 非 JSON 的 data 行忽略（心跳等）
    }
  }
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  return { status: res.status, contentType: res.headers.get('content-type'), headers, chunks, raw };
}

/** 把 text-delta chunk 拼成最终回答正文 */
export function textFromChunks(chunks: StreamChunk[]): string {
  return chunks
    .filter((c) => c.type === 'text-delta')
    .map((c) => String(c.delta))
    .join('');
}

/** 取 data-${name} 类型的 chunk 数据 */
export function dataChunks(chunks: StreamChunk[], name: string): unknown[] {
  return chunks.filter((c) => c.type === `data-${name}`).map((c) => c.data);
}
