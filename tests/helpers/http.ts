/**
 * 预配置的 axios HTTP 客户端 —— docs/16-d §D6 测试基建契约
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
  type TenantCode,
} from './auth';

function apiBase(): string {
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
 * 注意：customer 子系统当前只剩 POST /login（无 JWT 鉴权端点），所以这里不导出 customerHttp。
 *      loginCustomer() 仍保留（customer-auth.test.ts 测登录用），.e2e-tokens.json 也仍有 customer JWT 字段。
 */
export interface AllHttp {
  system: AxiosInstance;
  acmeAdmin: AxiosInstance;
  globAdmin: AxiosInstance;
  acmeApiKey: AxiosInstance;
  globApiKey: AxiosInstance;
}

export async function allHttpFromTokensFile(): Promise<AllHttp> {
  const t = await readTokensFile();
  return {
    system: systemHttp(t.system),
    acmeAdmin: adminHttp(t.acmeAdmin),
    globAdmin: adminHttp(t.globAdmin),
    acmeApiKey: apiKeyHttp(t.acmeApiKey),
    globApiKey: apiKeyHttp(t.globApiKey),
  };
}

/**
 * 主动重新登录拿一套新 HTTP（处理 JWT 过期 / 服务重启）
 */
export async function allHttpFresh(): Promise<AllHttp> {
  const [system, acmeAdmin, globAdmin] = await Promise.all([
    loginSystem(),
    loginAdmin('acme'),
    loginAdmin('globex'),
  ]);
  const t = await readTokensFile();
  return {
    system: systemHttp(system),
    acmeAdmin: adminHttp(acmeAdmin),
    globAdmin: adminHttp(globAdmin),
    acmeApiKey: apiKeyHttp(t.acmeApiKey),
    globApiKey: apiKeyHttp(t.globApiKey),
  };
}

// 保留 loginCustomer 供 customer-auth.test.ts 复用；这里不导出 HTTP 客户端（customer 没受保护端点）
void loginCustomer;
void ({} as TenantCode);
