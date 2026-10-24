import { Op } from 'sequelize';
import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { Context, Next } from 'koa';
import { ApiKey } from '../models';
import { AuthError } from './errors';
import { hashPassword, verifyPassword } from './password';
import { logger } from '../logger';

/**
 * 对外 API Key 鉴权 —— E1（docs/12-e-需求-业务接入与平台运营.md §E1）
 *
 * ============================ 密钥形态 ============================
 * 形态：  ak_<nanoid(32)>          （与 tests/helpers/fixtures.ts 的 seed 保持一致）
 * 落库：  key_prefix = 前 8 位      （"ak_" + 5 位随机；UI 上用来识别是哪把钥匙）
 *         key_hash   = bcrypt(raw, cost=12)  —— **只存 hash**，完整 key 仅创建时返回一次
 *
 * 为什么前缀只取 8 位还能定位到唯一一行：
 *   前缀里只有 5 位随机（nanoid 字母表 64 字符 → 约 30 bit），**不足以**单独定位一把钥匙。
 *   所以真正定位靠「prefix 粗筛 + bcrypt 逐个比对」：先用 prefix 查出一批候选行，
 *   再用 bcrypt.compare 逐个试，只有真 key 能比过。
 *   5 位随机在几百把钥匙的规模下撞车概率可以忽略；即使撞了也只是多比一次 bcrypt。
 *
 * ============================ 鉴权流程 ============================
 *   Authorization: Bearer ak_xxx     （首选）
 *   X-API-Key: ak_xxx                （备选，方便某些网关只透传自定义头）
 *   → 取出 raw → 查候选行 → bcrypt 比对 → 检查 revoked_at / expires_at
 *   → 成功后把 { apiKeyId, tenantId, name } 挂到 ctx.state.apiKey
 *
 * ============================ 为什么加一层内存缓存 ============================
 * bcrypt(cost=12) 单次比对要 200~300ms。对一个「每次外部调用都验一次」的公开 API 来说，
 * 这点延迟不可接受，而且纯属浪费 CPU。
 * 所以验过的 key 缓存在进程内（key = raw 的 sha256，不是明文）：
 *   - 命中缓存 → 直接放行，**不查库、不跑 bcrypt**
 *   - 未命中   → 走完整流程（查库 + bcrypt），成功后写缓存
 *
 * 缓存的代价（已知取舍，写在这里免得以后有人踩）：
 *   - 撤销（revoked_at）最多有 CACHE_TTL_MS 的延迟才生效。走 admin 撤销端点时
 *     会主动清缓存，所以「后台点撤销」是**立即生效**的；只有直接改库才会有延迟。
 *   - 缓存是进程内的：多实例部署时每个实例各缓存各的，行为一致（都是最多延迟 TTL）。
 *   - last_used_at 也只在缓存失效时更新（写库太频繁没必要）。
 */

/** API Key 的固定前缀 —— 跟 tests/helpers/fixtures.ts 里 seed 出来的格式一致 */
export const API_KEY_PREFIX = 'ak_';

/** key_prefix 列的长度：存 raw 的前 8 位（"ak_" + 5 位随机） */
export const API_KEY_PREFIX_LEN = 8;

/** 校验缓存的存活时间 */
const CACHE_TTL_MS = 60_000;

/** 缓存最多留多少条（防止被大量一次性 key 撑爆内存） */
const CACHE_MAX = 1000;

/** last_used_at 的最小更新间隔（毫秒）—— 每次请求都写库太浪费 */
const LAST_USED_THROTTLE_MS = 60_000;

/** 一次鉴权通过后的身份信息 */
export interface ApiKeyPrincipal {
  /** api_keys.id */
  keyId: string;
  /** 所属租户 —— 外部系统能访问哪些数据完全由它决定 */
  tenantId: string;
  /** 租户给这把钥匙起的名字（"生产环境" / "测试环境"），日志里用 */
  name: string;
}

interface CacheEntry {
  principal: ApiKeyPrincipal;
  /** 快照里的撤销 / 过期时间：缓存命中时也要再查一次，防止过期 key 继续用 */
  revokedAt: Date | null;
  expiresAt: Date | null;
  cachedAt: number;
}

/** raw 的 sha256（hex）—— 只用来当缓存 key，进程内不留明文 key */
function cacheKeyOf(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/** 进程内缓存：sha256(raw) → 验过的 key */
const cache = new Map<string, CacheEntry>();

/** 反向索引：keyId → 这把 key 命中的所有缓存条目（撤销时要一次性清掉） */
const cacheByKeyId = new Map<string, Set<string>>();

/** last_used_at 的节流表：keyId → 上次写入时间 */
const lastUsedAt = new Map<string, number>();

function sweepCache(now: number): void {
  for (const [k, v] of cache) {
    if (now - v.cachedAt > CACHE_TTL_MS) {
      cache.delete(k);
      removeCacheIndex(v.principal.keyId, k);
    }
  }
  for (const [k, t] of lastUsedAt) {
    if (now - t > LAST_USED_THROTTLE_MS * 4) {
      lastUsedAt.delete(k);
    }
  }
}

/** 从反向索引里摘掉一个缓存条目 */
function removeCacheIndex(keyId: string, cacheKey: string): void {
  const set = cacheByKeyId.get(keyId);
  if (set === undefined) {
    return;
  }
  set.delete(cacheKey);
  if (set.size === 0) {
    cacheByKeyId.delete(keyId);
  }
}

/**
 * 生成一把新的 API Key。
 *
 * 完整 key **只在这一次返回** —— 服务端只留 bcrypt hash，之后谁也拿不回去。
 */
export function generateApiKey(): { raw: string; prefix: string } {
  const raw = `${API_KEY_PREFIX}${nanoid(32)}`;
  return { raw, prefix: raw.slice(0, API_KEY_PREFIX_LEN) };
}

/** 把明文 key 变成可落库的 hash（bcrypt cost=12，跟用户密码一个强度档） */
export async function hashApiKey(raw: string): Promise<string> {
  return hashPassword(raw);
}

/**
 * 从请求头里取出 API Key（明文）。
 *
 * 两种写法都认：
 *   Authorization: Bearer ak_xxx
 *   X-API-Key: ak_xxx
 * 都没给返回 null（由调用方决定报什么错）。
 */
export function extractApiKey(ctx: Context): string | null {
  const auth = ctx.request.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const raw = auth.slice('Bearer '.length).trim();
    if (raw !== '') {
      return raw;
    }
  }
  const apiKeyHeader = ctx.request.headers['x-api-key'];
  const value = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
  if (typeof value === 'string' && value.trim() !== '') {
    return value.trim();
  }
  return null;
}

/** key 是否长得像一把 key（粗筛，避免对垃圾输入跑 bcrypt） */
function looksLikeApiKey(raw: string): boolean {
  return raw.startsWith(API_KEY_PREFIX) && raw.length >= API_KEY_PREFIX_LEN + 8;
}

/**
 * 校验一把 API Key，返回它的身份；无效 / 过期 / 已撤销一律返回 null。
 *
 * ⚠️ 这里**不抛错**：调用方（中间件）决定对外报什么。
 *   无效和「不存在」返回同一个结果，避免暴露 key 是否存在。
 */
export async function verifyApiKey(raw: string): Promise<ApiKeyPrincipal | null> {
  if (!looksLikeApiKey(raw)) {
    return null;
  }

  const now = Date.now();
  const ck = cacheKeyOf(raw);
  const hit = cache.get(ck);
  if (hit !== undefined) {
    if (now - hit.cachedAt > CACHE_TTL_MS) {
      cache.delete(ck);
    } else {
      // 过期 / 撤销用快照再判一次（快照是验的时候读的，不是无限期有效的）
      if (hit.revokedAt !== null) {
        return null;
      }
      if (hit.expiresAt !== null && hit.expiresAt.getTime() <= now) {
        return null;
      }
      return hit.principal;
    }
  }

  // prefix 粗筛：只取 raw 的前 8 位去查。
  // 用 LIKE 'ak_xxxxx%' 而不是等值，是为了让「前缀长度不是 8」的存量数据也能命中
  // （DDL 写的是 VARCHAR(10)，注释说 8 位；两边都兼容一下）。
  //
  // ⚠️ LIKE 里的 `_` 是单字符通配符，而 nanoid 的字母表里**就有 `_`**：
  //    不转义的话 'ak_ab_cd%' 会顺带匹配 'akXabYcd...'。
  //    这不会造成越权（最终还得 bcrypt 比对通过），但会平白多出候选行、白跑几次 bcrypt。
  //    所以这里把 `_` / `%` / `\` 转义掉（MySQL LIKE 的默认转义符就是反斜杠）。
  const prefix = raw.slice(0, API_KEY_PREFIX_LEN);
  const likePattern = `${prefix.replace(/([%_\\])/g, '\\$1')}%`;
  const candidates = await ApiKey.findAll({
    where: { key_prefix: { [Op.like]: likePattern } },
  });

  for (const row of candidates) {
    const matched = await verifyPassword(raw, row.key_hash);
    if (!matched) {
      continue;
    }
    const revokedAt = row.revoked_at;
    const expiresAt = row.expires_at;
    if (revokedAt !== null) {
      logger.info({ apiKeyId: row.id, tenantId: row.tenant_id }, 'API Key 已被撤销，拒绝');
      return null;
    }
    if (expiresAt !== null && expiresAt.getTime() <= now) {
      logger.info({ apiKeyId: row.id, tenantId: row.tenant_id }, 'API Key 已过期，拒绝');
      return null;
    }
    const principal: ApiKeyPrincipal = {
      keyId: row.id,
      tenantId: row.tenant_id,
      name: row.name,
    };
    if (cache.size >= CACHE_MAX) {
      sweepCache(now);
      if (cache.size >= CACHE_MAX) {
        cache.clear();
        cacheByKeyId.clear();
      }
    }
    cache.set(ck, { principal, revokedAt, expiresAt, cachedAt: now });
    const keys = cacheByKeyId.get(row.id) ?? new Set<string>();
    keys.add(ck);
    cacheByKeyId.set(row.id, keys);
    void touchLastUsedAt(row.id, now);
    return principal;
  }

  return null;
}

/**
 * 写 last_used_at（节流）。
 *
 * 写失败不影响鉴权结果 —— 这只是个「这把钥匙最近有人用」的展示字段。
 */
async function touchLastUsedAt(keyId: string, now: number): Promise<void> {
  const last = lastUsedAt.get(keyId);
  if (last !== undefined && now - last < LAST_USED_THROTTLE_MS) {
    return;
  }
  lastUsedAt.set(keyId, now);
  try {
    await ApiKey.update({ last_used_at: new Date(now) }, { where: { id: keyId } });
  } catch (err: unknown) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err), keyId },
      '更新 API Key last_used_at 失败（不影响鉴权）',
    );
  }
}

/**
 * 主动让一把 key 的缓存失效（撤销 / 删除 key 之后调用）。
 *
 * 不调的话，撤销最多要等 CACHE_TTL_MS 才生效。
 */
export function invalidateApiKeyCache(raw: string): void {
  cache.delete(cacheKeyOf(raw));
}

/**
 * 按 key id 让缓存失效。
 *
 * 撤销走的是这条：服务端只存 bcrypt hash，**拿不回明文 key**，
 * 所以没法用 invalidateApiKeyCache(raw) —— 只能靠反向索引按 id 找缓存条目。
 * 后台点「撤销」因此是**立即生效**的（直接改库才会等到 TTL）。
 */
export function invalidateApiKeyById(keyId: string): void {
  const keys = cacheByKeyId.get(keyId);
  if (keys === undefined) {
    return;
  }
  for (const k of keys) {
    cache.delete(k);
  }
  cacheByKeyId.delete(keyId);
}

/** 清空全部鉴权缓存（测试用） */
export function resetApiKeyCache(): void {
  cache.clear();
  cacheByKeyId.clear();
  lastUsedAt.clear();
}

/**
 * API Key 鉴权中间件。
 *
 * 用在 `/api/v1/public/*` 的对外端点上（跟 admin / customer 的 JWT 命名空间完全独立）。
 * 成功后 ctx.state.apiKey = { keyId, tenantId, name }。
 */
export async function apiKeyAuth(ctx: Context, next: Next): Promise<void> {
  const raw = extractApiKey(ctx);
  if (raw === null) {
    throw new AuthError('缺少 API Key');
  }
  const principal = await verifyApiKey(raw);
  if (principal === null) {
    // 无效 / 过期 / 已撤销 —— 一律同一个响应，不告诉调用方到底是哪个原因
    throw new AuthError('API Key 无效');
  }
  ctx.state.apiKey = principal;
  await next();
}
