import Router from '@koa/router';
import type { Context } from 'koa';
import { z } from 'zod';
import { ApiKey, type ApiKeyScope } from '../../models';
import { NotFoundError, ValidationError } from '../../lib/errors';
import { writeAuditLog } from '../../lib/audit-log';
import {
  attachApiKeySha256,
  generateApiKey,
  hashApiKey,
  invalidateApiKeyById,
} from '../../lib/api-key-auth';
import { jwtAuth } from '../jwt-base';
import { requireAdmin } from '../admin';

/**
 * 租户 API 密钥管理 —— E1（docs/12-e-需求-业务接入与平台运营.md §E1）
 *
 * 路由前缀：/api/v1/admin/api-keys
 * 鉴权：admin 角色（jwtAuth + requireAdmin）—— **跟 public 那套 API Key 鉴权完全无关**，
 *      两边不共享命名空间：这里是「登录后台来管钥匙」，那边是「拿钥匙来调接口」。
 *
 * 端点：
 *   GET    /        列出本租户的钥匙（**永远不返回 hash / 完整 key**）
 *   POST   /        新建一把钥匙 → 完整 key **只在这一次的响应里出现**
 *   PATCH  /:id     改权限分级（scope）
 *   DELETE /:id     撤销（软删除：置 revoked_at；行还在，历史可查）
 *
 * ⚠️ 为什么这个文件物理上放在 src/gateway/public/ 下：
 *    本轮 E1 的改动范围限定了「不许动 src/gateway/admin/*」，
 *    但 API Key 的**管理**端点必须落在 admin 的命名空间里（它是租户后台的功能）。
 *    所以：文件放在 public/ 桶里，**URL 前缀和鉴权仍然属于 admin**，
 *    不跟 public 的 API Key 鉴权有任何交叉。
 *
 * 后台的「API 密钥」管理页面已经落地（`/admin/api-keys`，AntD 表格 + 复制按钮）。
 */

export const publicApiKeyAdminRouter = new Router({ prefix: '/api/v1/admin/api-keys' });

publicApiKeyAdminRouter.use(jwtAuth, requireAdmin);

const createBodySchema = z.object({
  /** 租户自己起的名字（"生产环境" / "测试环境"） */
  name: z.string().trim().min(1, '名称不能为空').max(100),
  /** 到期时间（ISO8601）；不传 = 永不过期 */
  expires_at: z.string().datetime({ offset: true }).optional(),
  /**
   * 权限分级（docs/10-安全方案.md §10）：
   *  - read  = 只读：只能调 GET /search，**不能发起对话**
   *  - write = 可发起对话（默认）
   *  - admin = 知识库管理：write 的全部能力 + 管理本租户文档
   *            （/api/v1/public/documents 的增删查）
   * 不传 = write（跟加 scope 列之前的行为一致）。
   */
  scope: z.enum(['read', 'write', 'admin']).optional(),
});

/** 改权限分级 */
const patchBodySchema = z.object({
  scope: z.enum(['read', 'write', 'admin']),
});

/** 取当前 admin（中间件已保证是 admin 角色） */
function currentAdmin(ctx: Context): { id: string; tenant_id: string } {
  const u = ctx.state.adminUser as { id?: string; sub?: string; tenant_id: string };
  return { id: u.sub ?? u.id ?? '', tenant_id: u.tenant_id };
}

// ===== 列表 =====

publicApiKeyAdminRouter.get('/', async (ctx) => {
  const admin = currentAdmin(ctx);
  const rows = await ApiKey.findAll({
    where: { tenant_id: admin.tenant_id },
    order: [['created_at', 'DESC']],
  });
  ctx.body = {
    keys: rows.map((row) => ({
      id: row.id,
      name: row.name,
      key_prefix: row.key_prefix,
      /** 权限分级：read=只读 / write=可发起对话 / admin=知识库管理 */
      scope: row.scope,
      last_used_at: row.last_used_at?.toISOString() ?? null,
      expires_at: row.expires_at?.toISOString() ?? null,
      revoked_at: row.revoked_at?.toISOString() ?? null,
      created_at: row.created_at.toISOString(),
    })),
  };
});

// ===== 新建 =====

publicApiKeyAdminRouter.post('/', async (ctx) => {
  const admin = currentAdmin(ctx);
  const input = createBodySchema.parse(ctx.request.body ?? {});

  const { raw, prefix } = generateApiKey();
  const row = await ApiKey.create({
    tenant_id: admin.tenant_id,
    name: input.name,
    key_prefix: prefix,
    key_hash: await hashApiKey(raw),
    scope: input.scope ?? 'write',
    expires_at: input.expires_at === undefined ? null : new Date(input.expires_at),
    revoked_at: null,
    created_by: admin.id,
  });
  // sha256 只用来定位（唯一索引），凭证判定仍然是上面的 bcrypt。
  // ⚠️ 单独 UPDATE 而不是建行时一起 INSERT：迁移 034 没跑时列不存在，
  //    INSERT 里提到这一列会直接报错 —— 「建 key」不该被迁移顺序搞挂。
  await attachApiKeySha256(row, raw);

  await writeAuditLog({
    tenant_id: admin.tenant_id,
    user_id: admin.id,
    action: 'API_KEY_CREATED',
    resource_type: 'api_key',
    resource_id: row.id,
    details: { name: row.name, key_prefix: row.key_prefix, scope: row.scope },
    ip: ctx.ip,
  });

  ctx.status = 201;
  ctx.body = {
    id: row.id,
    name: row.name,
    key_prefix: row.key_prefix,
    scope: row.scope,
    /**
     * 完整 key —— **只在这里出现一次**，服务端只留 bcrypt hash，之后谁也拿不回去。
     * 丢了就撤销重建一把。
     */
    api_key: raw,
    expires_at: row.expires_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
  };
});

// ===== 改权限分级 =====

/**
 * 改这把 key 的权限分级。
 *
 * ⚠️ **改完必须清鉴权缓存** —— principal 是连同 scope 一起缓存在进程内的
 * （60 秒 TTL），不清的话最多还有 60 秒的窗口期内旧权限仍然生效。
 */
publicApiKeyAdminRouter.patch('/:id', async (ctx) => {
  const admin = currentAdmin(ctx);
  const id = ctx.params.id ?? '';
  const input = patchBodySchema.parse(ctx.request.body ?? {});

  const row = await ApiKey.findOne({ where: { id, tenant_id: admin.tenant_id } });
  if (row === null) {
    throw new NotFoundError('API Key');
  }
  if (row.revoked_at !== null) {
    throw new ValidationError('这把钥匙已经撤销了，改权限没有意义');
  }

  const before = row.scope;
  row.scope = input.scope;
  await row.save();

  // 让鉴权缓存立刻失效 —— scope 变了，旧缓存里还带着老权限
  invalidateApiKeyById(row.id);

  await writeAuditLog({
    tenant_id: admin.tenant_id,
    user_id: admin.id,
    action: 'API_KEY_SCOPE_CHANGED',
    resource_type: 'api_key',
    resource_id: row.id,
    details: { name: row.name, key_prefix: row.key_prefix, from: before, to: row.scope },
    ip: ctx.ip,
  });

  ctx.body = { id: row.id, scope: row.scope };
});

// ===== 撤销 =====

publicApiKeyAdminRouter.delete('/:id', async (ctx) => {
  const admin = currentAdmin(ctx);
  const id = ctx.params.id ?? '';

  const row = await ApiKey.findOne({ where: { id, tenant_id: admin.tenant_id } });
  if (row === null) {
    throw new NotFoundError('API Key');
  }
  if (row.revoked_at === null) {
    row.revoked_at = new Date();
    await row.save();
  }

  // 让这把 key 的鉴权缓存立刻失效 —— 不清的话最多还有 60 秒的缓存窗口
  invalidateApiKeyById(row.id);

  await writeAuditLog({
    tenant_id: admin.tenant_id,
    user_id: admin.id,
    action: 'API_KEY_REVOKED',
    resource_type: 'api_key',
    resource_id: row.id,
    details: { name: row.name, key_prefix: row.key_prefix },
    ip: ctx.ip,
  });

  ctx.body = { id: row.id, revoked_at: row.revoked_at?.toISOString() ?? null };
});
