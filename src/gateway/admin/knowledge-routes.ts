import Router from '@koa/router';
import { koaBody } from 'koa-body';
import path from 'path';
import { promises as fs } from 'fs';
import { z } from 'zod';
import { config as appConfig } from '../../config';
import { Document } from '../../models';
import { logger } from '../../logger';
import { jwtAuth } from '../jwt-base';
import { requireAdmin } from './middleware';
import { saveUpload } from '../../services/document-upload';
import { extractText, type SupportedFileType } from '../../services/document-parse';
import { ingestDocument } from '../../rag/ingest';
import { hybridSearch, type HybridHit } from '../../rag/hybrid-search';
import { bm25Remove } from '../../rag/bm25';
import { deleteDocumentPoints } from '../../rag/qdrant';
import { writeAuditLog } from '../../lib/audit-log';
import { NotFoundError, ValidationError } from '../../lib/errors';
import type { TenantUserJwtPayload } from '../../lib/jwt';

/**
 * admin 知识库路由 —— 详见 docs/16-c §C1 + docs/06 §6.3
 * 路由前缀：/api/v1/admin
 * 鉴权：admin 角色（jwtAuth + requireAdmin）
 *
 * 端点：
 *   GET    /knowledge                       列本租户文档（按上传时间倒序）
 *   POST   /knowledge/upload                上传 + 同步拆块/Embedding/入 Qdrant
 *   DELETE /knowledge/:id                   删除文档 + 同步删 Qdrant points
 *   POST   /knowledge/test                  检索测试（top 5 命中片段，不调 LLM）
 *
 * 同步处理：上传后 API 直接跑索引，成功 → 状态 'ready'；失败 → 'failed'。
 * 见 docs/15 §Step 4 验收。
 */

export const adminKnowledgeRouter = new Router({ prefix: '/api/v1/admin' });

adminKnowledgeRouter.use(jwtAuth, requireAdmin);

// ===== GET /knowledge · 列本租户文档 =====
adminKnowledgeRouter.get('/knowledge', async (ctx) => {
  const u = ctx.state.adminUser as TenantUserJwtPayload;
  const docs = await Document.findAll({
    where: { tenant_id: u.tenant_id },
    attributes: [
      'id',
      'title',
      'file_type',
      'status',
      'chunk_count',
      'uploaded_at',
      'updated_at',
    ],
    order: [['uploaded_at', 'DESC']],
    limit: 500,
  });
  ctx.body = { documents: docs.map((d) => d.toJSON()) };
});

// ===== POST /knowledge/upload =====
adminKnowledgeRouter.post(
  '/knowledge/upload',
  koaBody({
    multipart: true,
    formidable: {
      // 临时目录（koa-body 在这里落盘）
      uploadDir: path.resolve(appConfig.DATA_DIR, 'tmp'),
      keepExtensions: true,
      maxFileSize: appConfig.MAX_UPLOAD_BYTES,
    },
  }),
  async (ctx) => {
    const u = ctx.state.adminUser as TenantUserJwtPayload;
    const files = ctx.request.files;
    if (files === undefined || files === null) {
      throw new ValidationError('未上传文件');
    }
    const file = Array.isArray(files['file']) ? files['file']?.[0] : files['file'];
    if (file === undefined || file === null) {
      throw new ValidationError('未上传文件（field 必须是 file）');
    }

    const originalName = file.originalFilename ?? '';
    if (originalName === '') {
      throw new ValidationError('缺少原始文件名');
    }

    // 1. 保存到 ./data/uploads/{tenant_id}/
    let saved: Awaited<ReturnType<typeof saveUpload>>;
    try {
      saved = await saveUpload({
        tmpPath: file.filepath,
        originalFilename: originalName,
        tenantId: u.tenant_id,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('不支持的文件类型')) {
        throw new ValidationError(msg);
      }
      throw e;
    }

    // 2. 写 documents，状态 indexing
    const doc = await Document.create({
      tenant_id: u.tenant_id,
      title: saved.title,
      source: saved.storedName,
      file_type: saved.fileType,
      file_path: saved.absolutePath,
      status: 'indexing',
      uploaded_by: u.sub,
    });

    // 3. 同步处理：解析 → 拆块 → embedding → 入 Qdrant
    // 上传落地先写一条 DOCUMENT_UPLOAD audit（成功 / 失败都留痕）
    await writeAuditLog({
      tenant_id: u.tenant_id,
      user_id: u.sub,
      action: 'DOCUMENT_UPLOAD',
      resource_type: 'document',
      resource_id: doc.id,
      details: {
        title: saved.title,
        file_type: saved.fileType,
      },
      ip: ctx.ip,
    });

    try {
      const text = await extractText(saved.absolutePath, saved.fileType as SupportedFileType);
      const result = await ingestDocument({
        documentId: doc.id,
        tenantId: u.tenant_id,
        title: saved.title,
        text,
      });
      await Document.update(
        { status: 'ready', chunk_count: result.chunkCount },
        { where: { id: doc.id } },
      );

      ctx.status = 201;
      ctx.body = {
        id: doc.id,
        status: 'ready',
        chunk_count: result.chunkCount,
        title: saved.title,
        file_type: saved.fileType,
      };
    } catch (err: unknown) {
      await Document.update({ status: 'failed' }, { where: { id: doc.id } }).catch(() => {});
      logger.error(
        { docId: doc.id, err: err instanceof Error ? err.message : String(err) },
        '文档索引失败',
      );
      await writeAuditLog({
        tenant_id: u.tenant_id,
        user_id: u.sub,
        action: 'DOCUMENT_INDEX_FAILED',
        resource_type: 'document',
        resource_id: doc.id,
        details: {
          title: saved.title,
          error: err instanceof Error ? err.message : String(err),
        },
        ip: ctx.ip,
      });
      // 上传已成功落地 + 写了 documents 行；索引失败不抛 5xx，让前端拿到 id 显示「失败」状态
      ctx.status = 200;
      ctx.body = {
        id: doc.id,
        status: 'failed',
        chunk_count: 0,
        title: saved.title,
        file_type: saved.fileType,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
);

// ===== DELETE /knowledge/:id =====
adminKnowledgeRouter.delete('/knowledge/:id', async (ctx) => {
  const u = ctx.state.adminUser as TenantUserJwtPayload;
  const id = ctx.params.id;
  if (id === undefined || id === '') {
    throw new ValidationError('缺少文档 id');
  }
  const doc = await Document.findOne({ where: { id, tenant_id: u.tenant_id } });
  if (doc === null) {
    throw new NotFoundError('文档');
  }

  // 1. 删 Qdrant points（先删向量，再删 DB / 文件；任一失败不阻塞）
  await deleteDocumentPoints(doc.id).catch((e: unknown) => {
    logger.warn(
      { docId: doc.id, err: e instanceof Error ? e.message : String(e) },
      '删 Qdrant points 失败',
    );
  });
  // 1b. 删 BM25 内存索引（Step 5 新增；进程内 Map 跟 Qdrant 同步）
  try {
    bm25Remove({ tenantId: u.tenant_id, docId: doc.id });
  } catch (e: unknown) {
    logger.warn(
      { docId: doc.id, err: e instanceof Error ? e.message : String(e) },
      '删 BM25 索引失败',
    );
  }
  // 2. 删磁盘文件
  if (doc.file_path !== null) {
    await fs.unlink(doc.file_path).catch((e: unknown) => {
      logger.warn(
        { docId: doc.id, err: e instanceof Error ? e.message : String(e) },
        '删磁盘文件失败',
      );
    });
  }
  // 3. 删 DB 行
  await doc.destroy();

  await writeAuditLog({
    tenant_id: u.tenant_id,
    user_id: u.sub,
    action: 'DOCUMENT_DELETE',
    resource_type: 'document',
    resource_id: id,
    details: { title: doc.title },
    ip: ctx.ip,
  });

  ctx.status = 204;
});

// ===== POST /knowledge/test · 检索测试 =====
// Step 5 起改走 hybridSearch（向量 + BM25 + RRF）
//  - 响应里的 score 是 RRF 分（k=60），跟原 cosine similarity 不可比 → score_threshold 字段保留但忽略
//    （前端还没实现，调用方基本没人传；传了就 warn 提示 deprecated）
// 详见 docs/16-b §B2 + docs/15 §Step 5
const TestBody = z
  .object({
    query: z.string().min(1, '问句不能为空').max(2000),
    top_k: z.number().int().min(1).max(50).optional(),
    /** @deprecated Step 5 起 hybridSearch 不再支持（RRF 分数阈值无意义）；保留字段为兼容老调用 */
    score_threshold: z.number().min(0).max(1).optional(),
  })
  .passthrough();

adminKnowledgeRouter.post('/knowledge/test', async (ctx) => {
  const u = ctx.state.adminUser as TenantUserJwtPayload;
  const input = TestBody.parse(ctx.request.body);
  if (input.score_threshold !== undefined) {
    logger.warn(
      { tenantId: u.tenant_id, score_threshold: input.score_threshold },
      'POST /knowledge/test · score_threshold 已废弃（hybridSearch 不再支持）',
    );
  }
  const hits: HybridHit[] = await hybridSearch({
    query: input.query,
    tenantId: u.tenant_id,
    topK: input.top_k ?? 5,
  });
  ctx.body = {
    query: input.query,
    hits: hits.map((h) => ({
      doc_id: h.doc_id,
      chunk_index: h.chunk_index,
      source: h.source,
      score: Number(h.score.toFixed(6)),
      text: h.text,
      sources: h.sources, // ['vector' | 'bm25']；多源说明两边都命中 → RRF 累加
    })),
  };
});