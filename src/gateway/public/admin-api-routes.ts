import Router from '@koa/router';
import { koaBody } from 'koa-body';
import type { Context } from 'koa';
import path from 'node:path';
import { Op } from 'sequelize';
import { z } from 'zod';
import { config } from '../../config';
import { Document } from '../../models';
import { logger } from '../../logger';
import { apiKeyAuth, requireApiScope, type ApiKeyPrincipal } from '../../lib/api-key-auth';
import { writeAuditLog } from '../../lib/audit-log';
import { NotFoundError, RateLimitError, ValidationError } from '../../lib/errors';
import { checkRateLimit } from '../../services/rate-limit';
import { cleanupStaleTmpFiles, removeUploadedTmpFiles } from '../../services/document-upload';
import { ingestUpload, removeDocument } from '../../services/document-ingest';
import { resolveTenant } from './tenant-guard';

/**
 * 对外 REST API 的 **admin 档** —— E1（docs/12-e-需求-业务接入与平台运营.md §E1）
 *
 * 路由前缀：/api/v1/public
 * 鉴权：**API Key**（Authorization: Bearer ak_xxx / X-API-Key: ak_xxx），且**必须是 admin 档**
 *
 * ## 这一档是干什么的
 *
 * scope 的三档（docs/10-安全方案.md §10）：
 *   - `read`  = 只能查知识库（GET /search）
 *   - `write` = 还能发起对话（POST /chat、/chat/stream）
 *   - `admin` = **还能管理本租户的知识库**（本文件）
 *
 * 为什么第三档要有实打实的能力：
 *   外部系统拿着 `admin` 的 key，最常见的诉求就是「把我们这边的文档同步进你们的知识库」，
 *   以及「文档过期了要删掉」。这两件事在 spec 里写的是三级权限
 *   （只读 / 写入 / 管理员），但之前 `admin` 只是个枚举值 —— 后台下拉里能选、
 *   实际能力跟 `write` 一样，等于给用户一把「看着更大、实际没变」的钥匙。
 *   这一档补上之后，三档才是真的三档。
 *
 * ## 端点
 *
 *   GET    /documents        列出本租户文档
 *   POST   /documents        上传文档（表单字段名 `file`）→ 解析 → 拆块 → 向量化
 *   DELETE /documents/:id    删除文档（Qdrant points + BM25 + 磁盘文件 + DB 行）
 *
 * ## 安全边界
 *
 * - **只能碰自己租户的数据**：租户 id 来自 API Key 鉴权结果，调用方传不了
 * - **写操作全部留审计**：`DOCUMENT_UPLOAD` / `DOCUMENT_DELETE`，
 *   details 里带 `via: 'api'` + `api_key_id`（后台审计页能看出是 API 同步来的）
 * - **上传走同一套限制**：扩展名白名单（PDF / Markdown / TXT）+ 单文件大小上限
 *   （跟 admin 后台完全一样，实现在 src/services/document-ingest.ts）
 * - **限流**：按 key 一个桶，跟租户桶叠加 —— 防止一把 admin key 把磁盘写满
 *
 * ⚠️ **删除是真的删**：删掉之后向量、索引、磁盘文件、DB 行全没了。
 *    这就是「管理员」这一档的代价 —— 租户自己决定要不要给外部系统这个权限。
 */

export const publicAdminApiRouter = new Router({ prefix: '/api/v1/public' });

publicAdminApiRouter.use(apiKeyAuth);

/** 从 ctx.state 里取鉴权结果（apiKeyAuth 已经保证一定存在） */
function currentApiKey(ctx: Context): ApiKeyPrincipal {
  return ctx.state.apiKey as ApiKeyPrincipal;
}

/**
 * 按 key 限流（跟对话链路同一个桶：`apikey:<key id>`）。
 *
 * 上传要落盘、删除要动向量，**这两个都是「重」操作** —— 不限流的话，
 * 一把泄露的 admin key 能把磁盘写满 / 把知识库清空。
 */
async function enforceRateLimit(ctx: Context, tenantId: string, keyId: string): Promise<void> {
  const decision = await checkRateLimit(tenantId, `apikey:${keyId}`);
  if (!decision.allowed) {
    const retryAfterSec = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
    ctx.set('Retry-After', String(retryAfterSec));
    throw new RateLimitError(`请求过于频繁，请 ${retryAfterSec} 秒后再试`, decision.retryAfterMs);
  }
}

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['uploaded', 'indexing', 'ready', 'failed']).optional(),
  keyword: z.string().trim().max(200).optional(),
});

// ===== GET /documents · 列出本租户文档 =====

publicAdminApiRouter.get('/documents', requireApiScope('admin'), async (ctx) => {
  const principal = currentApiKey(ctx);
  const tenant = await resolveTenant(principal);
  const input = listQuerySchema.parse(ctx.request.query);

  const where: Record<string, unknown> = { tenant_id: tenant.id };
  if (input.status !== undefined) {
    where.status = input.status;
  }
  if (input.keyword !== undefined && input.keyword !== '') {
    where.title = { [Op.like]: `%${escapeLike(input.keyword)}%` };
  }

  const { rows, count } = await Document.findAndCountAll({
    where,
    // ⚠️ **不回 file_path / source** —— 那是服务器磁盘路径，对外系统没有意义，
    //    泄露了等于告诉别人我们的目录结构。id + title 足够外部系统做同步。
    attributes: [
      'id',
      'title',
      'file_type',
      'status',
      'chunk_count',
      'error_message',
      'uploaded_at',
      'updated_at',
    ],
    order: [['uploaded_at', 'DESC']],
    limit: input.page_size,
    offset: (input.page - 1) * input.page_size,
  });

  ctx.body = {
    documents: rows.map((d) => ({
      id: d.id,
      title: d.title,
      file_type: d.file_type,
      status: d.status,
      chunk_count: d.chunk_count,
      /** 索引失败的原因（status='failed' 时有值）—— 外部系统据此决定要不要重传 */
      error_message: d.error_message,
      uploaded_at: d.uploaded_at.toISOString(),
      updated_at: d.updated_at.toISOString(),
    })),
    pagination: {
      page: input.page,
      page_size: input.page_size,
      total: count,
      total_pages: Math.ceil(count / input.page_size),
    },
  };
});

// ===== POST /documents · 上传文档 =====

/**
 * ⚠️ **中间件顺序有讲究**：`requireApiScope('admin')` 必须排在 `koaBody` **前面** ——
 *    权限不够的时候要**在解析 body 之前**就拒掉，
 *    否则一个没权限的调用方传 50MB 文件，我们还得先把它落盘再返回 403。
 */
publicAdminApiRouter.post(
  '/documents',
  requireApiScope('admin'),
  koaBody({
    multipart: true,
    formidable: {
      uploadDir: path.resolve(config.DATA_DIR, 'tmp'),
      keepExtensions: true,
      maxFileSize: config.MAX_UPLOAD_BYTES,
    },
  }),
  async (ctx) => {
    const principal = currentApiKey(ctx);
    const tenant = await resolveTenant(principal);
    await enforceRateLimit(ctx, tenant.id, principal.keyId);

    // 自愈式清理：兜住那些处理器根本跑不到就中断的失败（如超出 maxFileSize）
    void cleanupStaleTmpFiles().catch(() => {});

    try {
      const file = firstFile(ctx.request.files);
      if (file === undefined) {
        throw new ValidationError('未上传文件（表单字段名必须是 file）');
      }
      const outcome = await ingestUpload({
        // 没有登录用户 —— 这份文档是「这把 API Key 传上来的」
        actor: { tenantId: tenant.id, uploadedBy: null, via: 'api', apiKeyId: principal.keyId },
        file,
        ip: ctx.ip,
      });
      ctx.status = outcome.status;
      ctx.body = outcome.body;
    } catch (err: unknown) {
      // 校验失败 / 处理中断 → 把 koa-body 落在 tmp 的临时文件清掉，别留垃圾
      await removeUploadedTmpFiles(ctx.request.files);
      throw err;
    }
  },
);

// ===== DELETE /documents/:id · 删除文档 =====

publicAdminApiRouter.delete('/documents/:id', requireApiScope('admin'), async (ctx) => {
  const principal = currentApiKey(ctx);
  const tenant = await resolveTenant(principal);
  await enforceRateLimit(ctx, tenant.id, principal.keyId);

  const id = ctx.params.id ?? '';
  if (id.trim() === '') {
    throw new ValidationError('缺少文档 id');
  }
  // 归属校验：查不到就是「不存在」—— 不泄露别的租户有没有这个 id
  const doc = await Document.findOne({ where: { id, tenant_id: tenant.id } });
  if (doc === null) {
    throw new NotFoundError('文档');
  }

  const failures = await removeDocument(doc, tenant.id);

  await writeAuditLog({
    tenant_id: tenant.id,
    // 没有登录用户 → user_id 为空，details 里记 api_key_id
    user_id: null,
    action: 'DOCUMENT_DELETE',
    resource_type: 'document',
    resource_id: doc.id,
    details: {
      title: doc.title,
      via: 'api',
      api_key_id: principal.keyId,
      cleanup_failures: failures,
    },
    ip: ctx.ip,
  });

  ctx.status = 204;
  if (failures.length > 0) {
    // 文件 / 向量清理失败要告诉调用方，但 DB 行已经删了、重试也没法重来，
    // 所以明确提示「需要人工清理」，而不是假装成功。
    ctx.set('X-Cleanup-Warning', encodeURIComponent(failures.join('; ')));
    logger.error({ docId: doc.id, failures }, '文档已删除，但部分资源清理失败');
  }
});

// ===== 内部辅助 =====

/** 从 koa-body 的 files 里取第一个上传文件（表单字段名必须是 file） */
function firstFile(
  files: Record<string, unknown> | undefined,
): { filepath: string; originalFilename?: string } | undefined {
  if (files === undefined || files === null) {
    return undefined;
  }
  const raw = files.file;
  if (Array.isArray(raw)) {
    return raw[0] as { filepath: string; originalFilename?: string } | undefined;
  }
  if (raw !== null && typeof raw === 'object') {
    return raw as { filepath: string; originalFilename?: string };
  }
  return undefined;
}

/** 转义 LIKE 通配符，否则用户搜 "100%" 会变成通配查询 */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}
