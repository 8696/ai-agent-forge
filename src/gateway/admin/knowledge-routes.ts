import Router from '@koa/router';
import { koaBody } from 'koa-body';
import type { Context } from 'koa';
import path from 'node:path';
import { Op } from 'sequelize';
import { z } from 'zod';
import { config } from '../../config';
import { Document, type DocumentFileType } from '../../models';
import { logger } from '../../logger';
import { jwtAuth } from '../jwt-base';
import { requireAdmin } from './middleware';
import {
  saveUpload,
  removeUploadFile,
  removeUploadedTmpFiles,
  cleanupStaleTmpFiles,
} from '../../services/document-upload';
import { extractText } from '../../services/document-parse';
import { ingestDocument } from '../../rag/ingest';
import { hybridSearch } from '../../rag/hybrid-search';
import { getSettingValue } from '../../services/tenant-settings';
import { bm25RemoveDoc, bm25ChunkCount } from '../../rag/bm25';
import { deleteDocumentPoints, countPoints } from '../../rag/qdrant';
import { writeAuditLog } from '../../lib/audit-log';
import { NotFoundError, ValidationError } from '../../lib/errors';
import type { TenantUserJwtPayload } from '../../lib/jwt';

/**
 * admin 知识库路由 —— 详见 docs/12-c-需求-管理员可配置.md §C1
 * 路由前缀：/api/v1/admin　鉴权：admin 角色（jwtAuth + requireAdmin）
 *
 * 端点：
 *   GET    /knowledge                 文档列表（含块数 + 向量总数）
 *   POST   /knowledge/upload          上传 → 解析 → 拆块 → Embedding → Qdrant（同步）
 *   POST   /knowledge/:id/reindex     对失败/旧文档重新索引（复用磁盘上的原文件）
 *   DELETE /knowledge/:id             删 Qdrant points + BM25 + 磁盘文件 + DB 行
 *   POST   /knowledge/search          检索测试（混合召回 + RRF 融合，不调 LLM）
 *
 * 跨租户隔离：所有查询强制带 ctx.state.adminUser.tenant_id；Qdrant 侧的
 * tenant_id 过滤写在 src/rag/qdrant.ts:vectorSearch 内部，调用方绕不过去。
 */

export const adminKnowledgeRouter = new Router({ prefix: '/api/v1/admin' });

adminKnowledgeRouter.use(jwtAuth, requireAdmin);

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['uploaded', 'indexing', 'ready', 'failed']).optional(),
  keyword: z.string().trim().max(200).optional(),
});

const searchBodySchema = z.object({
  query: z.string().trim().min(1, '检索词不能为空').max(500),
  top_k: z.number().int().min(1).max(50).default(5),
});

// ===== GET /knowledge · 文档列表 =====

adminKnowledgeRouter.get('/knowledge', async (ctx) => {
  const u = ctx.state.adminUser as TenantUserJwtPayload;
  const input = listQuerySchema.parse(ctx.query);

  const where: Record<string, unknown> = { tenant_id: u.tenant_id };
  if (input.status !== undefined) {
    where.status = input.status;
  }
  if (input.keyword !== undefined && input.keyword !== '') {
    where.title = { [Op.like]: `%${escapeLike(input.keyword)}%` };
  }

  const { rows, count } = await Document.findAndCountAll({
    where,
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
    documents: rows.map((d) => d.toJSON()),
    pagination: {
      page: input.page,
      page_size: input.page_size,
      total: count,
      total_pages: Math.ceil(count / input.page_size),
    },
    stats: {
      /** 本租户已 ready 的文档块数合计 */
      chunk_total: await sumReadyChunks(u.tenant_id),
      /** 本租户索引里的块数（BM25 内存索引；重启后会从 Qdrant 重建） */
      bm25_chunk_total: bm25ChunkCount(u.tenant_id),
      /** Qdrant 里全库点总数（跨租户，仅作运维参考，不给业务判断用） */
      qdrant_points: await countPoints(),
    },
  };
});

// ===== POST /knowledge/upload · 上传 + 索引 =====

adminKnowledgeRouter.post(
  '/knowledge/upload',
  koaBody({
    multipart: true,
    formidable: {
      uploadDir: path.resolve(config.DATA_DIR, 'tmp'),
      keepExtensions: true,
      maxFileSize: config.MAX_UPLOAD_BYTES,
    },
  }),
  async (ctx) => {
    const u = ctx.state.adminUser as TenantUserJwtPayload;

    // 自愈式清理：兜住那些处理器根本跑不到就中断的失败（如超出 maxFileSize）
    void cleanupStaleTmpFiles().catch(() => {});

    // koa-body 在进入处理器之前就已经把文件写到 DATA_DIR/tmp 了。
    // 校验失败（扩展名不支持 / 文件名非法）时必须自己把临时文件删掉，
    // 否则每次传个 .exe 都会在磁盘上留一份垃圾 —— 传的人没付出任何代价，
    // 却能把磁盘写满。saveUpload 成功时文件已被 rename 走，unlink 报 ENOENT 忽略即可。
    try {
      const file = firstFile(ctx.request.files);
      if (file === undefined) {
        throw new ValidationError('未上传文件（表单字段名必须是 file）');
      }
      await ingestUpload(ctx, u, file);
    } catch (err: unknown) {
      await removeUploadedTmpFiles(ctx.request.files);
      throw err;
    }
  },
);

/**
 * 上传 + 索引的主流程。校验 → 落盘 → 建行 → 同步索引。
 * 拆成独立函数是为了让调用方能统一在 catch 里清理 koa-body 的临时文件。
 */
async function ingestUpload(
  ctx: Context,
  u: TenantUserJwtPayload,
  file: { filepath: string; originalFilename?: string },
): Promise<void> {
  const originalFilename = file.originalFilename ?? '';
  if (originalFilename.trim() === '') {
    throw new ValidationError('缺少原始文件名');
  }

  let saved: Awaited<ReturnType<typeof saveUpload>>;
  try {
    saved = await saveUpload({
      tmpPath: file.filepath,
      originalFilename,
      tenantId: u.tenant_id,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // 类型不支持是用户能自己解决的问题 → 400；磁盘写失败是服务端问题 → 原样抛
    if (message.includes('不支持的文件类型') || message.includes('文件名无效')) {
      throw new ValidationError(message);
    }
    throw err;
  }

  let doc: Document;
  try {
    doc = await Document.create({
      tenant_id: u.tenant_id,
      title: saved.title,
      source: saved.source,
      file_type: saved.fileType,
      file_path: saved.absolutePath,
      status: 'indexing',
      uploaded_by: u.sub,
      metadata: { bytes: saved.bytes },
    });
  } catch (err: unknown) {
    // 文件已经从 tmp rename 到正式目录了，但 DB 里没有对应行 → 管理员在 UI 上
    // 永远看不到也删不掉它。建行失败就把文件收回去，避免留下无主文件。
    await removeUploadFile(saved.absolutePath).catch(() => {});
    throw err;
  }

  await writeAuditLog({
    tenant_id: u.tenant_id,
    user_id: u.sub,
    action: 'DOCUMENT_UPLOAD',
    resource_type: 'document',
    resource_id: doc.id,
    details: { title: saved.title, file_type: saved.fileType, bytes: saved.bytes },
    ip: ctx.ip,
  });

  const outcome = await indexDocument(doc, u, ctx.ip);
  ctx.status = outcome.status;
  ctx.body = outcome.body;
}

// ===== POST /knowledge/:id/reindex · 重新索引 =====

adminKnowledgeRouter.post('/knowledge/:id/reindex', async (ctx) => {
  const u = ctx.state.adminUser as TenantUserJwtPayload;
  const doc = await findOwnedDocument(ctx.params.id, u.tenant_id);

  if (doc.file_path === null || doc.file_type === null) {
    throw new ValidationError('该文档没有可用的原始文件，无法重新索引');
  }

  await doc.update({ status: 'indexing', error_message: null });
  const outcome = await indexDocument(doc, u, ctx.ip);
  ctx.status = outcome.status;
  ctx.body = outcome.body;
});

// ===== DELETE /knowledge/:id · 删除文档 =====

adminKnowledgeRouter.delete('/knowledge/:id', async (ctx) => {
  const u = ctx.state.adminUser as TenantUserJwtPayload;
  const doc = await findOwnedDocument(ctx.params.id, u.tenant_id);

  // 向量 / 索引先删，DB 行最后删：中途失败时 DB 里还留着记录，管理员能看到并重试，
  // 不会出现「DB 没记录但向量还在被检索命中」的幽灵数据。
  const failures: string[] = [];

  await deleteDocumentPoints(doc.id).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    failures.push(`qdrant:${message}`);
    logger.error({ docId: doc.id, err: message }, '删 Qdrant points 失败');
  });

  try {
    bm25RemoveDoc(u.tenant_id, doc.id);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    failures.push(`bm25:${message}`);
    logger.error({ docId: doc.id, err: message }, '删 BM25 索引失败');
  }

  if (doc.file_path !== null) {
    await removeUploadFile(doc.file_path).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`file:${message}`);
      logger.error({ docId: doc.id, err: message }, '删磁盘文件失败');
    });
  }

  await doc.destroy();

  await writeAuditLog({
    tenant_id: u.tenant_id,
    user_id: u.sub,
    action: 'DOCUMENT_DELETE',
    resource_type: 'document',
    resource_id: doc.id,
    details: { title: doc.title, cleanup_failures: failures },
    ip: ctx.ip,
  });

  // 文件 / 向量清理失败要告诉管理员，但 DB 行已经删了、重试也没法重来，
  // 所以明确提示「需要人工清理」，而不是假装成功。
  ctx.status = 204;
  if (failures.length > 0) {
    ctx.set('X-Cleanup-Warning', encodeURIComponent(failures.join('; ')));
    logger.error({ docId: doc.id, failures }, '文档已删除，但部分资源清理失败');
  }
});

// ===== POST /knowledge/search · 检索测试 =====

adminKnowledgeRouter.post('/knowledge/search', async (ctx) => {
  const u = ctx.state.adminUser as TenantUserJwtPayload;
  const input = searchBodySchema.parse(ctx.request.body);

  // 租户可以在后台关掉自己的重排（docs/12-c §C4）
  const rerankEnabled = await getSettingValue(u.tenant_id, 'rerank_enabled');

  const startedAt = Date.now();
  const hits = await hybridSearch({
    query: input.query,
    tenantId: u.tenant_id,
    topK: input.top_k,
    rerankEnabled: rerankEnabled === null ? undefined : rerankEnabled === true,
  });

  ctx.body = {
    query: input.query,
    took_ms: Date.now() - startedAt,
    /** 这一次的排序是不是重排模型给的（false = 没配服务 / 租户关了 / 调用失败降级） */
    rerank_applied: hits.some((h) => h.rerank_score !== null),
    hits: hits.map((h) => ({
      doc_id: h.doc_id,
      chunk_index: h.chunk_index,
      source: h.source,
      text: h.text,
      /** 相关度 [0,1]，1.0 = 最相关（重排生效时是重排分，否则是归一化 RRF 分） */
      score: Number(h.score.toFixed(4)),
      /** 原始 RRF 分（量级 0.016~0.033） */
      rrf_score: Number(h.rrf_score.toFixed(6)),
      /** 重排原始分；null = 这一条没经过重排 */
      rerank_score: h.rerank_score === null ? null : Number(h.rerank_score.toFixed(6)),
      sources: h.sources,
      vector_rank: h.vector_rank,
      bm25_rank: h.bm25_rank,
    })),
  };
});

// ===== 内部辅助 =====

/**
 * 解析 → 拆块 → 向量化 → 入库，并回填 documents 状态。
 *
 * 索引失败**不抛 5xx**：文件已经落地、DB 行已经建好，前端拿得到 id 去展示「失败」状态，
 * 管理员可以改完重试或直接删掉。抛 5xx 会让前端只能显示「上传失败」，反而丢掉了已创建的记录。
 */
async function indexDocument(
  doc: Document,
  u: TenantUserJwtPayload,
  ip: string | undefined,
): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    const parsed = await extractText(
      doc.file_path as string,
      doc.file_type as DocumentFileType,
    );
    const result = await ingestDocument({
      documentId: doc.id,
      tenantId: u.tenant_id,
      title: doc.title,
      text: parsed.text,
    });

    await doc.update({
      status: 'ready',
      chunk_count: result.chunkCount,
      error_message: null,
      metadata: { ...(doc.metadata ?? {}), pages: parsed.pages },
    });

    return {
      status: 201,
      body: {
        id: doc.id,
        title: doc.title,
        file_type: doc.file_type,
        status: 'ready',
        chunk_count: result.chunkCount,
        pages: parsed.pages,
      },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const brief = message.slice(0, 500);

    await doc
      .update({ status: 'failed', chunk_count: 0, error_message: brief })
      .catch((updateErr: unknown) => {
        logger.error(
          { docId: doc.id, err: updateErr },
          '回填索引失败状态出错',
        );
      });

    await writeAuditLog({
      tenant_id: u.tenant_id,
      user_id: u.sub,
      action: 'DOCUMENT_INDEX_FAILED',
      resource_type: 'document',
      resource_id: doc.id,
      details: { title: doc.title, error: brief },
      ip: ip ?? null,
    });

    return {
      status: 200,
      body: {
        id: doc.id,
        title: doc.title,
        file_type: doc.file_type,
        status: 'failed',
        chunk_count: 0,
        error: brief,
      },
    };
  }
}

/** 查文档并校验归属；跨租户访问一律按「不存在」处理，不泄露别的租户有没有这个 id */
async function findOwnedDocument(
  id: string | undefined,
  tenantId: string,
): Promise<Document> {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new ValidationError('缺少文档 id');
  }
  const doc = await Document.findOne({ where: { id, tenant_id: tenantId } });
  if (doc === null) {
    throw new NotFoundError('文档');
  }
  return doc;
}

async function sumReadyChunks(tenantId: string): Promise<number> {
  const rows = await Document.findAll({
    where: { tenant_id: tenantId, status: 'ready' },
    attributes: ['chunk_count'],
  });
  return rows.reduce((sum, d) => sum + d.chunk_count, 0);
}

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