import { Op } from 'sequelize';
import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { Context, Next } from 'koa';
import { ApiKey, type ApiKeyScope } from '../models';
import { AuthError, ForbiddenError } from './errors';
import { hashPassword, verifyPassword } from './password';
import { runWithTenant } from './tenant-context';
import { logger } from '../logger';

/**
 * 对外 API Key 鉴权 —— E1（docs/12-e-需求-业务接入与平台运营.md §E1）
 *
 * ============================ 密钥形态 ============================
 * 形态：  ak_<nanoid(32)>          （与 tests/helpers/fixtures.ts 的 seed 保持一致）
 * 落库：  key_prefix = 前 8 位      （"ak_" + 5 位随机；UI 上用来识别是哪把钥匙）
 *         key_hash   = bcrypt(raw, cost=12)  —— **只存 hash**，完整 key 仅创建时返回一次
 *         key_sha256 = sha256(raw)           —— **只用来定位**，不是凭证（迁移 034）
 *
 * ============================ 怎么找到「是哪一把钥匙」 ============================
 * 两步：
 *   1. **定位**（要快）：`key_sha256` 上有唯一索引 → 精确命中，O(log n)
 *   2. **验真**（要慢但准）：对定位到的那一行跑 bcrypt.compare
 *
 * ⚠️ 为什么以前要「prefix 粗筛 + 逐个 bcrypt」：
 *   以前**没有** sha256 这一列，只能拿 8 位前缀去捞候选 ——
 *   而 api_keys 上只有复合索引 (tenant_id, key_prefix)，
 *   **单独按 prefix 查走不了索引 → 每次鉴权都全表扫**（key 一多就慢）。
 *   加了 sha256 之后，新建的 key 走索引点查，全表扫的问题消失。
 *
 * ⚠️ 存量 key（迁移之前建的，key_sha256 为 NULL）仍然走得通：
 *   它们走「慢路径」——`key_sha256 IS NULL` + 前缀粗筛，
 *   索引区间只扫**还没回填的存量行**，不是全表；
 *   第一次鉴权成功时**自动回填** sha256，之后就都走快路径了（自愈）。
 *
 * ============================ 鉴权流程 ============================
 *   Authorization: Bearer ak_xxx     （首选）
 *   X-API-Key: ak_xxx                （备选，方便某些网关只透传自定义头）
 *   → 取出 raw → sha256 定位 → bcrypt 比对 → 检查 revoked_at / expires_at
 *   → 成功后把 { apiKeyId, tenantId, name, scope } 挂到 ctx.state.apiKey
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
  /**
   * 权限分级（docs/10-安全方案.md §10）——
   * 对外的 key 是**发到客户系统里**的，泄露一次就是「整租户的问答能力 + token 花费」全敞。
   * read 的 key 只能调只读端点，发起对话会被挡。
   */
  scope: ApiKeyScope;
}

interface CacheEntry {
  principal: ApiKeyPrincipal;
  /** 快照里的撤销 / 过期时间：缓存命中时也要再查一次，防止过期 key 继续用 */
  revokedAt: Date | null;
  expiresAt: Date | null;
  cachedAt: number;
}

/** raw 的 sha256（hex）—— 进程内缓存 key + 数据库定位列共用同一个值 */
export function sha256OfApiKey(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

// ============================================================
// 迁移 034 没跑时的降级
// ============================================================

/**
 * `api_keys.key_sha256` 列现在能不能用。
 *
 * ⚠️ **为什么要有这层兜底**：生产部署是「DBA 手动跑迁移 + 灰度」（docs/11），
 *    **代码可能先于迁移上线**。没有兜底的话：
 *      `SELECT ... WHERE key_sha256 = ?` 直接报 ER_BAD_FIELD_ERROR
 *      → **每一次 API Key 鉴权都 500** → 对外 API 整个瘫掉。
 *
 *    降级 = **退回老行为**（前缀粗筛 + bcrypt 逐个比对）：只是慢一点（走全表扫），
 *    不会挂。迁移补上、进程重启后自动走回快路径。
 *
 * 状态是**进程内**的：撞到一次「列不存在」就记住，之后不再重试那条快路径
 *（免得每个请求都白跑一次报错）。
 */
let sha256Support: 'unknown' | 'available' | 'missing' = 'unknown';

/**
 * MySQL 的「未知列」错误。
 *
 * mysql2 抛的是 `ER_BAD_FIELD_ERROR` / errno 1054 / SQLSTATE 42S22；
 * Sequelize 会把它包成 DatabaseError，原始错误挂在 `original`（有时也在 `parent`）。
 */
export function isMissingColumnError(err: unknown): boolean {
  const candidates: unknown[] = [err];
  if (err !== null && typeof err === 'object') {
    candidates.push((err as { original?: unknown }).original);
    candidates.push((err as { parent?: unknown }).parent);
  }
  for (const c of candidates) {
    if (c === null || typeof c !== 'object') {
      continue;
    }
    const e = c as { code?: string; errno?: number; sqlState?: string };
    if (e.code === 'ER_BAD_FIELD_ERROR' || e.errno === 1054 || e.sqlState === '42S22') {
      return true;
    }
  }
  return false;
}

/** sha256 列现在能不能用（false = 迁移 034 没跑，已降级） */
export function isApiKeySha256Supported(): boolean {
  return sha256Support !== 'missing';
}

/**
 * 降级：**把 key_sha256 这一列从模型里摘掉**，之后所有对 ApiKey 的查询都走前缀粗筛。
 *
 * ⚠️ **为什么必须摘列**（不只是改 WHERE）：
 *    Sequelize 的 SELECT 列清单来自**模型定义**，不是查询里写了什么。
 *    列不存在时，**任何**对 ApiKey 的查询都会报
 *    `Unknown column 'key_sha256' in 'field list'` ——
 *    不光是鉴权那一条（后台的 key 列表 / 改权限 / 撤销同样会挂）。
 *    `Model.removeAttribute()` 把这一列从 rawAttributes 里删掉并刷新列清单，
 *    所有查询立刻就不再引用它。
 */
function degradeToPrefixLookup(reason: string): void {
  sha256Support = 'missing';
  try {
    ApiKey.removeAttribute('key_sha256');
  } catch (err: unknown) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err) },
      '摘掉 ApiKey 的 key_sha256 属性失败',
    );
  }
  logger.warn(
    { reason },
    'api_keys.key_sha256 列不存在（迁移 034 没跑？），已降级为前缀粗筛',
  );
}

/**
 * 启动时探一次：`api_keys.key_sha256` 列在不在（迁移 034 跑了没）。
 *
 * ⚠️ **为什么在启动时探，而不是每个请求里 try/catch**：
 *    列不存在时每一次对 ApiKey 的查询都会报错（见 degradeToPrefixLookup 的说明），
 *    与其让每个请求都撞一次 500，不如启动时探一次、把列摘掉，**一次性解决所有路径**。
 *
 * 探针本身只在 WHERE 里提到这一列（SELECT 列清单只取 id），
 * 所以列不存在时它会报「Unknown column ... in 'where clause'」（同样是 errno 1054）。
 *
 * @returns 列在 = true（走索引快路径）；不在 = false（已降级）
 */
export async function probeApiKeySha256Column(): Promise<boolean> {
  try {
    await ApiKey.findOne({ where: { key_sha256: '__probe__' }, attributes: ['id'] });
    sha256Support = 'available';
    return true;
  } catch (err: unknown) {
    if (!isMissingColumnError(err)) {
      // 探针失败（DB 抖了一下之类）≠ 列不存在 —— 不降级，留给请求路径自己撞一次
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        '探测 api_keys.key_sha256 列失败（不降级，按存在处理）',
      );
      return sha256Support !== 'missing';
    }
    degradeToPrefixLookup(err instanceof Error ? err.message : String(err));
    return false;
  }
}

/**
 * 给一把 key 落 sha256（**只用于定位**，凭证判定仍是 bcrypt）。
 *
 * ⚠️ **列不存在时静默跳过** —— 迁移 034 没跑的话，定位退回「前缀粗筛」，
 *    只是慢一点，不该把「建 key」这个动作搞挂。
 *
 * 之所以单独 UPDATE 而不是建行时一起 INSERT：
 * Sequelize 的 INSERT 只写**显式赋值过**的字段（`_.intersection(Object.keys(values), tableAttributes)`），
 * 所以「不传 key_sha256」就不会在 SQL 里提到这一列 —— 列不存在也不会报错。
 */
export async function attachApiKeySha256(row: ApiKey, raw: string): Promise<void> {
  if (sha256Support === 'missing') {
    return;
  }
  try {
    await row.update({ key_sha256: sha256OfApiKey(raw) });
    sha256Support = 'available';
  } catch (err: unknown) {
    if (isMissingColumnError(err)) {
      degradeToPrefixLookup(err instanceof Error ? err.message : String(err));
      return;
    }
    logger.debug(
      { err: err instanceof Error ? err.message : String(err), apiKeyId: row.id },
      '写入 API Key 的 sha256 失败（不影响鉴权）',
    );
  }
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
  const sha = sha256OfApiKey(raw);
  const hit = cache.get(sha);
  if (hit !== undefined) {
    if (now - hit.cachedAt > CACHE_TTL_MS) {
      cache.delete(sha);
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

  // ===== 快路径：sha256 精确命中 =====
  //
  // key_sha256 上有唯一索引（迁移 034）→ 这是**索引点查**，不是全表扫。
  // 命中了就只有一行要跑 bcrypt。
  //
  // ⚠️ 这一步**故意不带 tenant_id 过滤**：租户上下文是 verify 成功之后才设的
  //    （runWithTenant 在 apiKeyAuth 里），此刻还不知道这把 key 属于哪个租户 ——
  //    归属由「sha256 唯一」+「bcrypt 比对」双重确定。
  let exact: ApiKey | null = null;
  if (sha256Support !== 'missing') {
    try {
      exact = await ApiKey.findOne({ where: { key_sha256: sha } });
      sha256Support = 'available';
    } catch (err: unknown) {
      if (!isMissingColumnError(err)) {
        throw err;
      }
      // 迁移 034 还没跑 → 摘掉这一列，退回老行为（慢，但不会挂）
      degradeToPrefixLookup(err instanceof Error ? err.message : String(err));
      exact = null;
    }
  }
  if (exact !== null) {
    const matched = await verifyPassword(raw, exact.key_hash);
    if (!matched) {
      // sha256 对上了但 bcrypt 对不上 —— 数据不一致（不该发生），当成无效处理
      logger.warn({ apiKeyId: exact.id }, 'API Key 的 sha256 与 bcrypt 哈希不一致，拒绝');
      return null;
    }
    return await finishAuth(exact, now, sha);
  }

  // ===== 慢路径：存量 key（key_sha256 还是 NULL）=====
  //
  // 存量行没有 sha256，只能退回「前缀粗筛 + bcrypt 逐个比对」。
  // 但加上 `key_sha256 IS NULL` 之后，索引区间只扫**还没回填的存量行**，
  // 而不是全表 —— 存量 key 用过一次就会被回填掉，之后再也不进这条路径。
  //
  // 用 LIKE 'ak_xxxxx%' 而不是等值，是为了让「前缀长度不是 8」的存量数据也能命中
  // （DDL 写的是 VARCHAR(10)，注释说 8 位；两边都兼容一下）。
  //
  // ⚠️ LIKE 里的 `_` 是单字符通配符，而 nanoid 的字母表里**就有 `_`**：
  //    不转义的话 'ak_ab_cd%' 会顺带匹配 'akXabYcd...'。
  //    这不会造成越权（最终还得 bcrypt 比对通过），但会平白多出候选行、白跑几次 bcrypt。
  //    所以这里把 `_` / `%` / `\` 转义掉（MySQL LIKE 的默认转义符就是反斜杠）。
  const prefix = raw.slice(0, API_KEY_PREFIX_LEN);
  const likePattern = `${prefix.replace(/([%_\\])/g, '\\$1')}%`;
  // 列不存在时（迁移没跑）退回**不带** key_sha256 条件的老查询
  const legacy =
    sha256Support === 'missing'
      ? await ApiKey.findAll({ where: { key_prefix: { [Op.like]: likePattern } } })
      : await ApiKey.findAll({
          where: { key_sha256: null, key_prefix: { [Op.like]: likePattern } },
        });

  for (const row of legacy) {
    const matched = await verifyPassword(raw, row.key_hash);
    if (!matched) {
      continue;
    }
    // 回填 sha256（自愈）：这把 key 下次就走快路径了
    await backfillSha256(row, sha);
    return await finishAuth(row, now, sha);
  }

  return null;
}

/**
 * 把存量 key 的 sha256 回填上去（自愈）。
 *
 * 回填失败不影响本次鉴权结果 —— 这一行只是为了下次能走快路径。
 */
async function backfillSha256(row: ApiKey, sha: string): Promise<void> {
  if (sha256Support === 'missing') {
    return;
  }
  try {
    await ApiKey.update({ key_sha256: sha }, { where: { id: row.id, key_sha256: null } });
  } catch (err: unknown) {
    if (isMissingColumnError(err)) {
      degradeToPrefixLookup(err instanceof Error ? err.message : String(err));
      return;
    }
    logger.debug(
      { err: err instanceof Error ? err.message : String(err), apiKeyId: row.id },
      '回填 API Key 的 sha256 失败（不影响本次鉴权）',
    );
  }
}

/**
 * bcrypt 已经比对通过之后的后半程：查撤销 / 过期 → 写缓存 → 返回身份。
 */
async function finishAuth(row: ApiKey, now: number, sha: string): Promise<ApiKeyPrincipal | null> {
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
    scope: row.scope,
  };
  if (cache.size >= CACHE_MAX) {
    sweepCache(now);
    if (cache.size >= CACHE_MAX) {
      cache.clear();
      cacheByKeyId.clear();
    }
  }
  cache.set(sha, { principal, revokedAt, expiresAt, cachedAt: now });
  const keys = cacheByKeyId.get(row.id) ?? new Set<string>();
  keys.add(sha);
  cacheByKeyId.set(row.id, keys);
  void touchLastUsedAt(row.id, now);
  return principal;
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
  cache.delete(sha256OfApiKey(raw));
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
  // 本租户上下文 —— 租户作用域钩子靠它自动补 tenant_id 过滤（A1）。
  // ⚠️ 必须在 verifyApiKey **之后**才设：那一步的 prefix 粗筛是故意跨租户的
  //    （key_prefix 只有 8 位，捞候选再逐个 bcrypt 比对），那时还不知道租户是谁。
  return runWithTenant(principal.tenantId, next);
}

// ============================================================
// 权限分级（docs/10-安全方案.md §10）
// ============================================================

/**
 * scope 的包含关系：**write ⊇ read，admin ⊇ write**。
 *
 * 「这把 key 的权限够不够要 read」就是一次大小比较。
 */
function scopeRank(scope: ApiKeyScope): number {
  if (scope === 'admin') return 3;
  if (scope === 'write') return 2;
  return 1;
}

/**
 * 要求这把 key 至少有某个权限。
 *
 * 用法：
 *   只读端点 → `requireApiScope('read')`
 *   发起对话 → `requireApiScope('write')`（会花钱、会留会话记录）
 *
 * ⚠️ **权限不足返 403 不是 401**：key 本身是有效的，只是权限不够。
 * 返 401 会让调用方以为「key 失效了」从而反复换 key 重试。
 */
export function requireApiScope(
  required: ApiKeyScope,
): (ctx: Context, next: Next) => Promise<void> {
  return (ctx: Context, next: Next): Promise<void> => {
    const principal = ctx.state.apiKey as ApiKeyPrincipal | undefined;
    if (principal === undefined) {
      throw new AuthError('缺少 API Key');
    }
    if (scopeRank(principal.scope) < scopeRank(required)) {
      logger.warn(
        { apiKeyId: principal.keyId, tenantId: principal.tenantId, scope: principal.scope, required },
        'API Key 权限不足，拒绝',
      );
      throw new ForbiddenError(`API Key 权限不足（需要 ${required} 权限）`);
    }
    return next();
  };
}
