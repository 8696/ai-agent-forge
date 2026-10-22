import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from '../config';
import { ValidationError } from './errors';

/**
 * 租户自定义 LLM 端点的合法性校验 —— docs/12-c §C4
 *
 * 租户能在后台填 `base_url`，这意味着**我们的后端会向任意地址发 HTTP 请求**。
 * 这就是教科书里的 SSRF：多租户 SaaS 里，一个租户填
 * `http://169.254.169.254/latest/meta-data/` 或 `http://10.0.0.5:8080/admin`，
 * 就能读到云元数据（临时凭据）或者打穿内网。所以这里必须有一道闸。
 *
 * 校验策略：
 *  - 协议必须是 http / https（别的直接拒）
 *  - 主机名解析后，**每个 A/AAAA 记录都不许落在内网段**：
 *    回环 127/8、链路本地 169.254/16（含云元数据）、私网 10/8 · 172.16/12 · 192.168/16、
 *    CGNAT 100.64/10、IPv6 唯一本地 fc00::/7
 *  - 为什么要**逐个 IP 校验**而不是只看主机名：攻击者可以用 `nip.io` 这类
 *    把内网 IP 解析成域名的服务绕过字符串判断，只能看 DNS 解析结果
 *  - 开发环境默认放开（本地可能就要指到 127.0.0.1 的 mock 网关）；
 *    生产默认拦截，确实要指自建网关时用 CONFIG_ALLOW_PRIVATE_LLM_ENDPOINT=true 显式开
 */

/** 生产默认拦截；dev 放开。本地 mock 网关、局域网自建网关靠这个开关。 */
function allowPrivateEndpoint(): boolean {
  return config.CONFIG_ALLOW_PRIVATE_LLM_ENDPOINT || config.NODE_ENV !== 'production';
}

/** IPv4 的私有 / 特殊用途网段 */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return false;
  }
  const [a, b] = [parts[0] ?? 0, parts[1] ?? 0];
  if (a === 127) return true; // 回环
  if (a === 10) return true; // 私网
  if (a === 172 && b >= 16 && b <= 31) return true; // 私网
  if (a === 192 && b === 168) return true; // 私网
  if (a === 169 && b === 254) return true; // 链路本地（云元数据在这）
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 0) return true; // 「本网络」
  return false;
}

/** IPv6 的 ::1 / fc00::/7 / fe80::/10 */
function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === '::1' || normalized === '::') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // 唯一本地
  if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) {
    return true; // 链路本地
  }
  // IPv4 映射地址（::ffff:10.0.0.1）——按 IPv4 规则判
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped?.[1] !== undefined) {
    return isPrivateIPv4(mapped[1]);
  }
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return isPrivateIPv4(ip);
  if (kind === 6) return isPrivateIPv6(ip);
  return false;
}

export interface EndpointCheck {
  ok: boolean;
  /** ok=false 时的中文原因，直接给 admin 看 */
  reason?: string;
}

/**
 * 校验一个 base_url。返回 `{ok:false, reason}` 而不是抛异常 ——
 * 想把它用在「保存时拒绝」和「调用前复查」两处，后者不该把配置弹回后台。
 */
export async function checkLlmEndpoint(rawUrl: string): Promise<EndpointCheck> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: '不是合法的 URL' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, reason: `协议只支持 http / https，收到 ${parsed.protocol.replace(':', '')}` };
  }
  if (allowPrivateEndpoint()) {
    return { ok: true };
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  // 字面量 IP 直接判，不用查 DNS
  if (net.isIP(host) !== 0) {
    return isPrivateAddress(host)
      ? { ok: false, reason: `不允许指向内网地址 ${host}（如确需自建网关，请设 CONFIG_ALLOW_PRIVATE_LLM_ENDPOINT=true）` }
      : { ok: true };
  }

  let records: Array<{ address: string }>;
  try {
    records = [...(await dns.lookup(host, { all: true }))];
  } catch (err: unknown) {
    return { ok: false, reason: `域名解析失败：${err instanceof Error ? err.message : String(err)}` };
  }
  if (records.length === 0) {
    return { ok: false, reason: `域名 ${host} 没有解析到任何地址` };
  }
  const bad = records.find((r) => isPrivateAddress(r.address));
  if (bad !== undefined) {
    return {
      ok: false,
      reason: `${host} 解析到了内网地址 ${bad.address}（如确需自建网关，请设 CONFIG_ALLOW_PRIVATE_LLM_ENDPOINT=true）`,
    };
  }
  return { ok: true };
}

/** 保存配置时用：校验不过直接抛 400 */
export async function assertLlmEndpoint(rawUrl: string): Promise<void> {
  const result = await checkLlmEndpoint(rawUrl);
  if (!result.ok) {
    throw new ValidationError(`LLM 端点不可用：${result.reason ?? '未知原因'}`);
  }
}