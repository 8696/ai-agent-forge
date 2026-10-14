import type { Context, Next } from 'koa';
import bcrypt from 'bcrypt';
import { Op } from 'sequelize';
import { ApiKey, Tenant } from '../models';
import { AuthError } from '../lib/errors';
import { assertTenantAccessible } from '../lib/tenant-gate';
import { logger } from '../logger';

/**
 * API Key 鉴权中间件 —— 给「对外」端点用（/api/v1/chat, /api/v1/chat/stream 等）
 *
 * 详见 docs/06 §6.2 + docs/15 §Step 6 + docs/16-e §E1
 *
 * 接受 header（任一即可）：
 *   - Authorization: Bearer <key>
 *   - X-API-Key:       <key>
 *
 * 流程：
 *  1. 取 raw key
 *  2. 用 key_prefix 收窄候选（避免全表 bcrypt）
 *  3. bcrypt.compare 任一命中即通过
 *  4. 校验未撤销（revoked_at IS NULL）+ 未过期（expires_at IS NULL OR > now）
 *  5. 校验租户可用（status=active 且未到期；走 assertTenantAccessible 防自锁一致行为）
 *  6. 通过后 ctx.state.apiContext = { tenantId, apiKeyId, keyPrefix }
 *  7. 异步更新 last_used_at（不阻塞响应）
 *
 * 注意：
 *  - bcrypt cost=12 在每请求验证会 ~200ms；MVP 接受，Step 12 加 lru-cache
 *  - E1 的 CRUD 端点（建 / 撤销 / 列）Step 9 落，本文件只读验证
 */
export interface ApiContext {
  tenantId: string;
  apiKeyId: string;
  keyPrefix: string;
}

export async function apiKeyAuth(ctx: Context, next: Next): Promise<void> {
  const raw = readRawKey(ctx);
  if (raw === null) {
    throw new AuthError('未提供 API Key');
  }
  if (raw.length < 12 || !raw.startsWith('ak_')) {
    // 立即拒绝明显非法的 key（避免落库查），减少 bcrypt 误触
    throw new AuthError('API Key 格式无效');
  }

  const apiKey = await findActiveKey(raw);
  if (apiKey === null) {
    throw new AuthError('API Key 无效');
  }

  const tenant = await Tenant.findByPk(apiKey.tenant_id);
  if (tenant === null) {
    throw new AuthError('租户不存在');
  }
  // 与 admin/customer/login 闸门共用：status=disabled 或 expires_at 已过 → 一律 401
  assertTenantAccessible(tenant);

  ctx.state.apiContext = {
    tenantId: apiKey.tenant_id,
    apiKeyId: apiKey.id,
    keyPrefix: apiKey.key_prefix,
  } satisfies ApiContext;

  // last_used_at 异步更新（不阻塞响应；失败仅 warn）
  void ApiKey.update(
    { last_used_at: new Date() },
    { where: { id: apiKey.id } },
  ).catch((e: unknown) => {
    logger.warn(
      { apiKeyId: apiKey.id, err: e instanceof Error ? e.message : String(e) },
      '更新 api_key.last_used_at 失败',
    );
  });

  await next();
}

function readRawKey(ctx: Context): string | null {
  const auth = ctx.request.headers.authorization;
  if (auth !== undefined && auth.startsWith('Bearer ')) {
    const t = auth.slice('Bearer '.length).trim();
    if (t !== '') return t;
  }
  const x = ctx.request.headers['x-api-key'];
  if (typeof x === 'string' && x.trim() !== '') {
    return x.trim();
  }
  return null;
}

async function findActiveKey(raw: string): Promise<ApiKey | null> {
  const prefix = raw.slice(0, 8);
  const candidates = await ApiKey.findAll({
    where: {
      key_prefix: prefix,
      revoked_at: { [Op.is]: null },
    },
  });
  const now = Date.now();
  for (const k of candidates) {
    if (k.expires_at !== null && k.expires_at.getTime() <= now) continue;
    const ok = await bcrypt.compare(raw, k.key_hash);
    if (ok) return k;
  }
  return null;
}
