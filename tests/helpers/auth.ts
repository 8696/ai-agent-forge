/**
 * 测试 fixture JWT 登录 —— docs/16-d §D6 测试基建契约
 *
 * 提供 5 个登录入口（system / 2 租户的 admin / 2 租户的 customer），拿 JWT 字符串。
 * 同时提供 loginAll() 一键完成 5 个登录 + 写 .e2e-tokens.json 给后续测试复用。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getFixtures } from './fixtures';

const TOKENS_FILE = path.resolve(process.cwd(), '.e2e-tokens.json');

export interface TokensFile {
  system: string;
  acmeAdmin: string;
  acmeCustomer: string;
  globAdmin: string;
  globCustomer: string;
  acmeApiKey: string;
  globApiKey: string;
}

export type TenantCode = 'acme' | 'globex';

interface LoginResponse {
  token: string;
}

/**
 * 调一个 login 端点。错误响应抛 Error（让 Agent 立刻看到，不会静默吞）
 */
async function postLogin(path: string, body: unknown, apiBase: string): Promise<string> {
  const res = await fetch(`${apiBase}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`login ${path} failed: status=${res.status} body=${text}`);
  }
  try {
    const json = JSON.parse(text) as LoginResponse;
    if (typeof json.token !== 'string' || json.token.length < 10) {
      throw new Error(`login ${path}: 响应缺少 token 字段`);
    }
    return json.token;
  } catch (e) {
    throw new Error(`login ${path}: JSON 解析失败 ${text}`);
  }
}

function apiBase(): string {
  return process.env.API_BASE ?? `http://localhost:${process.env.PORT ?? '3099'}`;
}

export async function loginSystem(): Promise<string> {
  const fx = getFixtures().system;
  return postLogin('/api/v1/system/login', { email: fx.email, password: fx.password }, apiBase());
}

export async function loginAdmin(tenantCode: TenantCode): Promise<string> {
  const t = getFixtures().tenants.find((x) => x.code === tenantCode);
  if (t === undefined) throw new Error(`fixtures.json 找不到租户 ${tenantCode}`);
  return postLogin(
    '/api/v1/admin/login',
    { email: t.admin.email, password: t.admin.password, tenant_code: tenantCode },
    apiBase(),
  );
}

export async function loginCustomer(tenantCode: TenantCode): Promise<string> {
  const t = getFixtures().tenants.find((x) => x.code === tenantCode);
  if (t === undefined) throw new Error(`fixtures.json 找不到租户 ${tenantCode}`);
  return postLogin(
    '/api/v1/customer/login',
    { email: t.customer.email, password: t.customer.password, tenant_code: tenantCode },
    apiBase(),
  );
}

/**
 * API Key 不走 login：直接从 fixtures 里读 seed 时记录的 raw key。
 * seed.ts 会把所有凭据打到 .e2e-tokens.json（含 raw key）。
 */
export async function getApiKey(tenantCode: TenantCode): Promise<string> {
  const tokens = await readTokensFile();
  const key = tenantCode === 'acme' ? tokens.acmeApiKey : tokens.globApiKey;
  if (typeof key !== 'string' || !key.startsWith('ak_')) {
    throw new Error(
      `.e2e-tokens.json 缺少 ${tenantCode} 的 API key；先跑 yarn seed && yarn e2e:login`,
    );
  }
  return key;
}

/**
 * 把 5 个 JWT + 2 个 API Key 一起写到 .e2e-tokens.json（前后端测试共用）
 */
export async function writeTokensFile(tokens: TokensFile): Promise<void> {
  await fs.writeFile(TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

/**
 * 读 .e2e-tokens.json（测试脚本里直接拿现成 JWT，0 网络请求）
 */
export async function readTokensFile(): Promise<TokensFile> {
  try {
    const raw = await fs.readFile(TOKENS_FILE, 'utf8');
    return JSON.parse(raw) as TokensFile;
  } catch {
    throw new Error(
      `.e2e-tokens.json 读不到；先跑 \`yarn seed && yarn e2e:login\`（cwd=${process.cwd()}）`,
    );
  }
}
