import Router from '@koa/router';
import { koaBody } from 'koa-body';
import path from 'node:path';
import { Op } from 'sequelize';
import { z } from 'zod';
import { config } from '../../config';
import { Document } from '../../models';
import { logger } from '../../logger';
import { jwtAuth } from '../jwt-base';
import { requireAdmin } from './middleware';
import {
  removeUploadedTmpFiles,
  cleanupStaleTmpFiles,
} from '../../services/document-upload';
import {
  ingestUpload,
  indexDocument,
  removeDocument,
} from '../../services/document-ingest';
import { hybridSearch } from '../../rag/hybrid-search';
import { getSettingValue } from '../../services/tenant-settings';
import { bm25ChunkCount } from '../../rag/bm25';
import { countPoints, fetchDocChunks, fetchDocChunkVectors } from '../../rag/qdrant';
import { writeAuditLog } from '../../lib/audit-log';
import {
  auditChunkEdit,
  isChunkStoreAvailable,
  ensureChunkRows,
  loadChunks,
  mergeChunkTexts,
  rewriteVectors,
  saveChunks,
  splitChunkText,
  type StoredChunk,
} from '../../services/document-chunks';
import { AppError, NotFoundError, ValidationError } from '../../lib/errors';
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
 *   GET    /knowledge/:id/chunks      查看一篇文档的切片（诊断用，只读）
 *   POST   /knowledge/search          检索测试（混合召回 + RRF 融合，不调 LLM）
 *
 * 跨租户隔离：所有查询强制带 ctx.state.adminUser.tenant_id；Qdrant 侧的
 * tenant_id 过滤写在 src/rag/qdrant.ts:vectorSearch 内部，调用方绕不过去。
 *
 * ⚠️ **上传 / 索引 / 删除的实现抽在 src/services/document-ingest.ts** ——
 *    对外 API 的 admin 档（src/gateway/public/admin-api-routes.ts）走同一套，
 *    免得两条路长歪。
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

const chunkListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
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
      const outcome = await ingestUpload({
        actor: { tenantId: u.tenant_id, uploadedBy: u.sub, via: 'admin' },
        file,
        ip: ctx.ip,
      });
      ctx.status = outcome.status;
      ctx.body = outcome.body;
    } catch (err: unknown) {
      await removeUploadedTmpFiles(ctx.request.files);
      throw err;
    }
  },
);

// ===== POST /knowledge/:id/reindex · 重新索引 =====

adminKnowledgeRouter.post('/knowledge/:id/reindex', async (ctx) => {
  const u = ctx.state.adminUser as TenantUserJwtPayload;
  const doc = await findOwnedDocument(ctx.params.id, u.tenant_id);

  if (doc.file_path === null || doc.file_type === null) {
    throw new ValidationError('该文档没有可用的原始文件，无法重新索引');
  }

  await doc.update({ status: 'indexing', error_message: null });
  const outcome = await indexDocument(
    doc,
    { tenantId: u.tenant_id, uploadedBy: u.sub, via: 'admin' },
    ctx.ip,
  );
  ctx.status = outcome.status;
  ctx.body = outcome.body;
});

// ===== DELETE /knowledge/:id · 删除文档 =====

adminKnowledgeRouter.delete('/knowledge/:id', async (ctx) => {
  const u = ctx.state.adminUser as TenantUserJwtPayload;
  const doc = await findOwnedDocument(ctx.params.id, u.tenant_id);

  // 向量 / 索引先删，DB 行最后删：中途失败时 DB 里还留着记录，管理员能看到并重试，
  // 不会出现「DB 没记录但向量还在被检索命中」的幽灵数据。
  const failures = await removeDocument(doc, u.tenant_id);

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

// ===== GET /knowledge/:id/chunks · 查看文档的切片 =====

/**
 * 拉一篇文档的全部块 —— **诊断用途**（后台「切片浏览」页）。
 *
 * ⚠️ **两道隔离闸，缺一不可**：
 *   1. `findOwnedDocument` —— 确认这个文档 id 属于本租户（否则 404）
 *   2. `fetchDocChunks` 里的 `tenant_id` 过滤 —— 确认捞出来的块也是本租户的
 *   只做第 1 道 → 万一 Qdrant 里残留着别的租户的同 id 点，会被捞出来；
 *   只做第 2 道 → 别的租户传个 id 过来就能看别人文档的块。
 *
 * 这是**只读**的诊断接口，不写审计（没有状态变更）。
 */
adminKnowledgeRouter.get('/knowledge/:id/chunks', async (ctx) => {
  const u = ctx.state.adminUser as TenantUserJwtPayload;
  const doc = await findOwnedDocument(ctx.params.id, u.tenant_id);
  const input = chunkListQuerySchema.parse(ctx.query);

  const result = await fetchDocChunks({
    docId: doc.id,
    tenantId: u.tenant_id,
    page: input.page,
    pageSize: input.page_size,
  });

  /**
   * 「有没有被人工改过」标记来自 DB（Qdrant 的 payload 里没有这个概念）。
   *
   * ⚠️ **正文还是从 Qdrant 取** —— 不是所有文档都有 DB 副本
   *    （迁移 036 之前入库的、或者降级模式下索引的），
   *    从 Qdrant 取才能保证「这篇文档有多少块」始终对得上。
   */
  let editedFlags = new Map<number, boolean>();
  if (isChunkStoreAvailable()) {
    const stored = await loadChunks(u.tenant_id, doc.id);
    editedFlags = new Map(stored.map((r) => [r.chunkIndex, r.edited]));
  }

  ctx.body = {
    document: {
      id: doc.id,
      title: doc.title,
      file_type: doc.file_type,
      status: doc.status,
      chunk_count: doc.chunk_count,
      /** 这篇文档有没有人工编辑过的块（重新索引时会被保留） */
      has_manual_edits: [...editedFlags.values()].some((v) => v),
    },
    chunks: result.chunks.map((chunk) => ({
      ...chunk,
      edited: editedFlags.get(chunk.chunk_index) ?? false,
    })),
    pagination: {
      page: result.page,
      page_size: result.page_size,
      total: result.total,
      total_pages: result.total_pages,
    },
  };
});

// ===== 切片编辑 · 写操作 =====

/**
 * 切片的**写操作**（编辑 / 拆分 / 合并 / 还原）。
 *
 * ## 三件事必须一起做，缺一不可
 *
 *   1. **重算向量** —— 一块文本 = 一个向量。只改 text 不改 vector，
 *      检索按旧向量排序却返回新文字 → 模型看到的文本和向量对不上。
 *      （没改的块复用旧向量 —— 改 1 块不用重算 100 次 embedding）
 *   2. **同步 BM25** —— 第二路召回，进程内内存索引
 *   3. **写 DB 权威副本** —— Qdrant 只是检索索引，不是能编辑、能撤销的地方
 *
 * ## 租户隔离（三道）
 *
 *   1. `findOwnedDocument` —— 文档归属本租户
 *   2. `loadChunks` 的 `tenant_id` 过滤 —— 块归属本租户
 *   3. Qdrant 侧的 `tenant_id` 过滤 —— 向量归属本租户
 *
 * ## 审计
 *
 * 全部留痕（`DOCUMENT_CHUNK_EDITED` / `_SPLIT` / `_MERGED` / `_RESET`）——
 * 人工改过的知识库内容，得能查出是谁改的。
 */

const chunkEditBodySchema = z.object({
  text: z.string().min(1, '块内容不能为空').max(20000, '块内容太长（上限 20000 字）'),
});

const chunkSplitBodySchema = z.object({
  /** 拆分的字符位置（相对整块文本） */
  at: z.coerce.number().int().min(0, '拆分位置不合法'),
});

const chunkMergeBodySchema = z.object({
  /** 要合并的块序号（必须连续） */
  indexes: z
    .array(z.coerce.number().int().min(0))
    .min(2, '至少选两块才能合并')
    .max(20, '一次最多合并 20 块'),
});

/** 切片编辑功能现在能不能用（迁移 036 跑没跑） */
function ensureChunkStoreAvailable(): void {
  if (!isChunkStoreAvailable()) {
    throw new AppError(
      '切片编辑功能不可用：数据库迁移 036（document_chunks 表）还没跑。请先执行 yarn migrate。',
      'CHUNK_STORE_UNAVAILABLE',
      503,
    );
  }
}

/** 解析块序号（路由参数） */
function parseChunkIndex(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new ValidationError('块序号不合法');
  }
  return n;
}

/**
 * 把改过的块列表写回（向量 → BM25 → DB → 审计）。
 *
 * ⚠️ **顺序**：先写向量再写 DB。向量写失败（embedding 服务挂了）时 DB 不动 ——
 *    用户的编辑没生效，可以直接重试；反过来先写 DB 的话，
 *    DB 记着「已编辑」而索引还是旧的，用户会以为改了其实没改。
 */
async function applyChunkChanges(params: {
  doc: Document;
  tenantId: string;
  userId: string;
  rows: StoredChunk[];
  action: 'DOCUMENT_CHUNK_EDITED' | 'DOCUMENT_CHUNK_SPLIT' | 'DOCUMENT_CHUNK_MERGED' | 'DOCUMENT_CHUNK_RESET';
  details: Record<string, unknown>;
  ip?: string | undefined;
}): Promise<{ embedded: number; reused: number; chunk_count: number }> {
  const { doc, tenantId, userId, rows } = params;

  // 旧向量必须在写回**之前**取（写回会先删掉旧点）
  const existing = await fetchDocChunkVectors({ docId: doc.id, tenantId });

  const stats = await rewriteVectors({
    docId: doc.id,
    tenantId,
    title: doc.title,
    rows,
    existing,
  });

  await saveChunks(
    tenantId,
    doc.id,
    rows.map((row) => ({
      chunkIndex: row.chunkIndex,
      text: row.text,
      generatedText: row.generatedText,
      headingPath: row.headingPath,
      sourceCharStart: row.sourceCharStart,
      sourceCharEnd: row.sourceCharEnd,
      sectionChunkIndex: row.sectionChunkIndex,
      sectionChunkTotal: row.sectionChunkTotal,
      edited: row.edited,
      editedBy: row.editedBy,
      editedAt: row.editedAt,
    })),
  );

  await doc.update({ chunk_count: rows.length });

  await auditChunkEdit({
    tenantId,
    userId,
    documentId: doc.id,
    documentTitle: doc.title,
    action: params.action,
    details: { chunk_count: rows.length, ...params.details },
    ip: params.ip,
  });

  return { ...stats, chunk_count: rows.length };
}

/** 找出某个块序号对应的行 */
function pickChunk(rows: StoredChunk[], index: number): StoredChunk {
  const row = rows.find((r) => r.chunkIndex === index);
  if (row === undefined) {
    throw new NotFoundError('切片');
  }
  return row;
}

/** 重新编号（拆分 / 合块之后块数变了，序号要连着排） */
function renumber(rows: StoredChunk[]): StoredChunk[] {
  return rows.map((row, i) => ({ ...row, chunkIndex: i }));
}

// ===== PATCH /knowledge/:id/chunks/:index · 改一块的文字 =====

adminKnowledgeRouter.patch('/knowledge/:id/chunks/:index', async (ctx) => {
  const u = ctx.state.adminUser as TenantUserJwtPayload;
  const doc = await findOwnedDocument(ctx.params.id, u.tenant_id);
  ensureChunkStoreAvailable();
  const index = parseChunkIndex(ctx.params.index);
  const input = chunkEditBodySchema.parse(ctx.request.body);

  // ⚠️ **ensureChunkRows**：迁移 036 之前索引的老文档没有 DB 副本 →
  //    从 Qdrant 补一份（否则「找不到这一块」，老文档完全没法编辑）
  const rows = await ensureChunkRows(u.tenant_id, doc);
  const target = pickChunk(rows, index);

  const before = target.text;
  target.text = input.text;
  target.edited = true;
  target.editedBy = u.sub;
  target.editedAt = new Date();

  const stats = await applyChunkChanges({
    doc,
    tenantId: u.tenant_id,
    userId: u.sub,
    rows,
    action: 'DOCUMENT_CHUNK_EDITED',
    details: { chunk_index: index, before_length: before.length, after_length: input.text.length },
    ip: ctx.ip,
  });

  ctx.body = { chunk_index: index, ...stats };
});

// ===== POST /knowledge/:id/chunks/:index/split · 把一块拆成两块 =====

adminKnowledgeRouter.post('/knowledge/:id/chunks/:index/split', async (ctx) => {
  const u = ctx.state.adminUser as TenantUserJwtPayload;
  const doc = await findOwnedDocument(ctx.params.id, u.tenant_id);
  ensureChunkStoreAvailable();
  const index = parseChunkIndex(ctx.params.index);
  const input = chunkSplitBodySchema.parse(ctx.request.body);

  // ⚠️ **ensureChunkRows**：迁移 036 之前索引的老文档没有 DB 副本 →
  //    从 Qdrant 补一份（否则「找不到这一块」，老文档完全没法编辑）
  const rows = await ensureChunkRows(u.tenant_id, doc);
  const target = pickChunk(rows, index);
  const { left, right } = splitChunkText(target.text, input.at);

  const pos = rows.findIndex((r) => r.chunkIndex === index);
  const now = new Date();
  const head: StoredChunk = {
    ...target,
    text: left,
    generatedText: left,
    edited: true,
    editedBy: u.sub,
    editedAt: now,
  };
  const tail: StoredChunk = {
    ...target,
    chunkIndex: index + 1,
    text: right,
    generatedText: right,
    edited: true,
    editedBy: u.sub,
    editedAt: now,
  };
  const next = renumber([
    ...rows.slice(0, pos),
    head,
    tail,
    ...rows.slice(pos + 1),
  ]);

  const stats = await applyChunkChanges({
    doc,
    tenantId: u.tenant_id,
    userId: u.sub,
    rows: next,
    action: 'DOCUMENT_CHUNK_SPLIT',
    details: { chunk_index: index, at: input.at },
    ip: ctx.ip,
  });

  ctx.body = { ...stats };
});

// ===== POST /knowledge/:id/chunks/merge · 把几块合并成一块 =====

adminKnowledgeRouter.post('/knowledge/:id/chunks/merge', async (ctx) => {
  const u = ctx.state.adminUser as TenantUserJwtPayload;
  const doc = await findOwnedDocument(ctx.params.id, u.tenant_id);
  ensureChunkStoreAvailable();
  const input = chunkMergeBodySchema.parse(ctx.request.body);

  const indexes = [...new Set(input.indexes)].sort((a, b) => a - b);
  for (let i = 1; i < indexes.length; i += 1) {
    if (indexes[i] !== (indexes[i - 1] as number) + 1) {
      throw new ValidationError('只能合并**连续**的块');
    }
  }

  // ⚠️ **ensureChunkRows**：迁移 036 之前索引的老文档没有 DB 副本 →
  //    从 Qdrant 补一份（否则「找不到这一块」，老文档完全没法编辑）
  const rows = await ensureChunkRows(u.tenant_id, doc);
  const picked = indexes.map((i) => pickChunk(rows, i));
  const mergedText = mergeChunkTexts(picked.map((r) => r.text));

  const first = picked[0] as StoredChunk;
  const last = picked[picked.length - 1] as StoredChunk;
  const now = new Date();
  const merged: StoredChunk = {
    ...first,
    text: mergedText,
    generatedText: mergedText,
    // 源区间取并集 —— 重新索引时靠它把这一块对回去
    sourceCharStart: Math.min(...picked.map((r) => r.sourceCharStart)),
    sourceCharEnd: Math.max(...picked.map((r) => r.sourceCharEnd)),
    edited: true,
    editedBy: u.sub,
    editedAt: now,
  };

  const next = renumber([
    ...rows.filter((r) => r.chunkIndex < first.chunkIndex),
    merged,
    ...rows.filter((r) => r.chunkIndex > last.chunkIndex),
  ]);

  const stats = await applyChunkChanges({
    doc,
    tenantId: u.tenant_id,
    userId: u.sub,
    rows: next,
    action: 'DOCUMENT_CHUNK_MERGED',
    details: { indexes },
    ip: ctx.ip,
  });

  ctx.body = { ...stats };
});

// ===== POST /knowledge/:id/chunks/:index/reset · 还原成程序生成的文本 =====

adminKnowledgeRouter.post('/knowledge/:id/chunks/:index/reset', async (ctx) => {
  const u = ctx.state.adminUser as TenantUserJwtPayload;
  const doc = await findOwnedDocument(ctx.params.id, u.tenant_id);
  ensureChunkStoreAvailable();
  const index = parseChunkIndex(ctx.params.index);

  // ⚠️ **ensureChunkRows**：迁移 036 之前索引的老文档没有 DB 副本 →
  //    从 Qdrant 补一份（否则「找不到这一块」，老文档完全没法编辑）
  const rows = await ensureChunkRows(u.tenant_id, doc);
  const target = pickChunk(rows, index);
  const before = target.text;
  target.text = target.generatedText;
  target.edited = false;
  target.editedBy = null;
  target.editedAt = null;

  const stats = await applyChunkChanges({
    doc,
    tenantId: u.tenant_id,
    userId: u.sub,
    rows,
    action: 'DOCUMENT_CHUNK_RESET',
    details: { chunk_index: index, before_length: before.length },
    ip: ctx.ip,
  });

  ctx.body = { chunk_index: index, ...stats };
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