import { DocumentChunk } from '../models/DocumentChunk';
import type { Transaction } from 'sequelize';
import { logger } from '../logger';
import { ValidationError } from '../lib/errors';
import { writeAuditLog } from '../lib/audit-log';
import { fetchDocChunkVectors, fetchDocChunks, type ExistingChunkVector } from '../rag/qdrant';
import { writeDocumentChunks, type ChunkToWrite } from '../rag/ingest';
import type { PreservedEdit } from '../rag/chunk';

/**
 * 文档切片的**编辑服务** —— 后台「切片浏览」页的写操作
 *
 * ## 为什么正文在 MySQL 而不是只存在 Qdrant
 *
 * 切片的正文以前只有一份真身（Qdrant payload）。那对「查看」够用，对「编辑」不够：
 *   - Qdrant 不是 CMS —— 没事务、没版本、没法撤销
 *   - 「重新索引」= 从磁盘原文件重切 → **静默吃掉所有人工编辑**
 *
 * 所以 `document_chunks` 表是**权威副本**，Qdrant 只是检索索引。
 * 见 docs/05-a-数据模型-mysql.md §文档切片表。
 *
 * ## 编辑之后一定要重算向量
 *
 * 一块文本 = 一个向量。改了 text 不改 vector →
 * 检索按**旧向量**排序却返回**新文字** → 模型看到的文本和向量代表的意思对不上。
 * 所以每次编辑都要重算**被改动的那几块**的向量；没改的块复用旧向量（省 embedding 调用）。
 *
 * ## 租户隔离
 *
 * 两道闸：
 *   1. `DocumentChunk` 带 tenant_id 列 → Sequelize 租户作用域钩子自动补过滤
 *   2. 这里每条查询都**显式**带 tenant_id（不靠钩子兜底 —— 钩子是止血阀，不是设计）
 */

/** 元素之间的分隔符（跟切块器 src/rag/chunk.ts 保持一致） */
const SEP = '\n\n';

/**
 * 表在不在（迁移 036 跑没跑）。
 *
 * ⚠️ **降级设计**：代码可能先于迁移上线（生产是「DBA 手动跑迁移 + 灰度」）。
 *    表不在时：
 *      - 索引 / 检索**照常工作**（只写 Qdrant，不写 DB）
 *      - 编辑功能**不可用**（端点返回 503，提示先跑迁移）
 *    而不是让整个知识库挂掉。
 */
let chunkStoreAvailable = false;

/** 启动时探一次表在不在（跟迁移 034 / 035 一个路子） */
export async function probeDocumentChunksTable(): Promise<void> {
  try {
    await DocumentChunk.count();
    chunkStoreAvailable = true;
  } catch (err: unknown) {
    chunkStoreAvailable = false;
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'document_chunks 表不存在（迁移 036 没跑？）—— 切片编辑功能不可用，索引与检索不受影响',
    );
  }
}

/** 切片编辑功能现在能不能用 */
export function isChunkStoreAvailable(): boolean {
  return chunkStoreAvailable;
}

/** DB 里的一块 */
export interface StoredChunk {
  chunkIndex: number;
  /** 当前文本（进向量的完整文本：面包屑 + 重叠区 + 正文） */
  text: string;
  /** 最近一次由程序生成的文本（「还原」的依据） */
  generatedText: string;
  headingPath: string[] | null;
  /** 这块在归一化原文里的区间 */
  sourceCharStart: number;
  sourceCharEnd: number;
  sectionChunkIndex: number;
  sectionChunkTotal: number;
  /** 有没有被人工干预过（改过文字或改过结构） */
  edited: boolean;
  editedBy: string | null;
  editedAt: Date | null;
}

/** 读一篇文档的全部块（按 chunk_index 升序） */
export async function loadChunks(tenantId: string, documentId: string): Promise<StoredChunk[]> {
  const rows = await DocumentChunk.findAll({
    where: { tenant_id: tenantId, document_id: documentId },
    order: [['chunk_index', 'ASC']],
  });
  return rows.map((row) => ({
    chunkIndex: row.chunk_index,
    text: row.text,
    generatedText: row.generated_text,
    headingPath: Array.isArray(row.heading_path) ? row.heading_path : null,
    sourceCharStart: row.source_char_start,
    sourceCharEnd: row.source_char_end,
    sectionChunkIndex: row.section_chunk_index,
    sectionChunkTotal: row.section_chunk_total,
    edited: row.edited,
    editedBy: row.edited_by,
    editedAt: row.edited_at,
  }));
}

/**
 * 拿一篇文档的块 —— **没有 DB 副本时从 Qdrant 补一份**。
 *
 * ## 为什么要补
 *
 * 迁移 036 之前入库的文档，块只在 Qdrant 里，DB 里没有副本
 * → 编辑接口会「找不到这一块」→ 404，**老文档完全没法编辑**。
 *
 * 补的方式：从 Qdrant 把正文 + 标题路径搬过来，标成「没被编辑过」。
 *
 * ⚠️ **补出来的块 `source_char_*` 是 0** —— Qdrant 的 payload 里没有源区间。
 *    这不影响编辑（编辑不看源区间），也不影响重新索引
 *    （`edited=false` 的块本来就不参与人工编辑搬运）。
 */
export async function ensureChunkRows(
  tenantId: string,
  doc: { id: string; title: string },
): Promise<StoredChunk[]> {
  const rows = await loadChunks(tenantId, doc.id);
  if (rows.length > 0) {
    return rows;
  }

  const first = await fetchDocChunks({ docId: doc.id, tenantId, pageSize: 100 });
  if (first.total === 0) {
    return [];
  }
  const all = [...first.chunks];
  for (let page = 2; page <= first.total_pages; page += 1) {
    const next = await fetchDocChunks({ docId: doc.id, tenantId, page, pageSize: 100 });
    all.push(...next.chunks);
  }

  await saveChunks(
    tenantId,
    doc.id,
    all.map((chunk) => ({
      chunkIndex: chunk.chunk_index,
      text: chunk.text,
      // 补出来的块：程序生成的文本 = 当前文本（没被人工改过）
      generatedText: chunk.text,
      headingPath: chunk.heading_path,
      sourceCharStart: 0,
      sourceCharEnd: 0,
      sectionChunkIndex: chunk.section_chunk_index ?? 0,
      sectionChunkTotal: chunk.section_chunk_total ?? 0,
      edited: false,
      editedBy: null,
      editedAt: null,
    })),
  );

  return loadChunks(tenantId, doc.id);
}

/** 一行要写进 DB 的块 */
export interface ChunkRowInput {
  chunkIndex: number;
  text: string;
  generatedText: string;
  headingPath: string[] | null;
  sourceCharStart: number;
  sourceCharEnd: number;
  sectionChunkIndex: number;
  sectionChunkTotal: number;
  edited: boolean;
  editedBy?: string | null | undefined;
  editedAt?: Date | null | undefined;
}

/**
 * 全量替换一篇文档的块行。
 *
 * ⚠️ **先删后插** —— 块的数量会变（拆分 / 合块），逐行 update 会留下残块。
 * ⚠️ **在一个事务里** —— 中途失败不能出现「删了一半」的文档。
 */
export async function saveChunks(
  tenantId: string,
  documentId: string,
  rows: ChunkRowInput[],
): Promise<void> {
  // 用模型上的 sequelize 实例（避免 services → db 的循环依赖）
  const sequelize = DocumentChunk.sequelize;
  if (sequelize === undefined) {
    throw new Error('Sequelize 实例还没初始化 —— document_chunks 不可用');
  }
  await sequelize.transaction(async (t: Transaction) => {
    await DocumentChunk.destroy({
      where: { tenant_id: tenantId, document_id: documentId },
      transaction: t,
    });
    if (rows.length > 0) {
      await DocumentChunk.bulkCreate(
        rows.map((row) => ({
          tenant_id: tenantId,
          document_id: documentId,
          chunk_index: row.chunkIndex,
          text: row.text,
          generated_text: row.generatedText,
          heading_path: row.headingPath,
          source_char_start: row.sourceCharStart,
          source_char_end: row.sourceCharEnd,
          section_chunk_index: row.sectionChunkIndex,
          section_chunk_total: row.sectionChunkTotal,
          edited: row.edited,
          edited_by: row.editedBy ?? null,
          edited_at: row.editedAt ?? null,
        })),
        { transaction: t },
      );
    }
  });
}

/** 把 DB 里的块转成「可写回向量库」的形状 */
function toWriteChunks(rows: StoredChunk[]): ChunkToWrite[] {
  return rows.map((row) => ({
    index: row.chunkIndex,
    text: row.text,
    headingPath: row.headingPath ?? [],
    sectionChunkIndex: row.sectionChunkIndex,
    sectionChunkTotal: row.sectionChunkTotal,
  }));
}

/**
 * 把一份文档的块重新写回向量库 + BM25（**复用没变的块的向量**）。
 *
 * @param existing 旧块（文本 + 向量）—— 必须在写回**之前**取（写回会先删旧点）
 */
export async function rewriteVectors(params: {
  docId: string;
  tenantId: string;
  title: string;
  rows: StoredChunk[];
  existing?: ExistingChunkVector[] | undefined;
}): Promise<{ embedded: number; reused: number }> {
  return writeDocumentChunks({
    docId: params.docId,
    tenantId: params.tenantId,
    title: params.title,
    chunks: toWriteChunks(params.rows),
    existing: params.existing,
  });
}

/**
 * 重新索引时，把「人工编辑过的块」整理成可搬回新块的编辑记录。
 *
 * 只有 `edited=true` 的块算人工编辑 —— 没被碰过的块用新切法切出来的就行。
 */
export function collectPreservedEdits(rows: StoredChunk[]): PreservedEdit[] {
  const edits: PreservedEdit[] = [];
  for (const row of rows) {
    if (!row.edited) {
      continue;
    }
    edits.push({
      sourceCharStart: row.sourceCharStart,
      sourceCharEnd: row.sourceCharEnd,
      text: row.text,
    });
  }
  return edits;
}

/**
 * 读一篇文档的人工编辑（重新索引时搬回新块用）。
 *
 * ⚠️ **表不存在时返回空数组** —— 降级模式下（迁移 036 没跑），
 *    重新索引就是「回到当前切法的原始切块」，不会报错。
 */
export async function loadPreservedEdits(
  tenantId: string,
  documentId: string,
): Promise<PreservedEdit[]> {
  if (!chunkStoreAvailable) {
    return [];
  }
  const rows = await loadChunks(tenantId, documentId);
  return collectPreservedEdits(rows);
}

/** 索引完之后把块写进 DB（权威副本） */
export async function saveIndexedChunks(params: {
  tenantId: string;
  documentId: string;
  chunks: Array<{
    index: number;
    text: string;
    generatedText: string;
    headingPath: string[];
    charStart: number;
    charEnd: number;
    sectionChunkIndex: number;
    sectionChunkTotal: number;
    /** 人工编辑有没有被搬回来 */
    preserved: boolean;
  }>;
  /** 上一轮的块（拿 edited_by / edited_at） */
  previous?: StoredChunk[] | undefined;
}): Promise<void> {
  if (!chunkStoreAvailable) {
    return;
  }
  const prevByIndex = new Map((params.previous ?? []).map((r) => [r.chunkIndex, r]));
  await saveChunks(
    params.tenantId,
    params.documentId,
    params.chunks.map((c) => {
      const old = prevByIndex.get(c.index);
      return {
        chunkIndex: c.index,
        text: c.text,
        generatedText: c.generatedText,
        headingPath: c.headingPath,
        sourceCharStart: c.charStart,
        sourceCharEnd: c.charEnd,
        sectionChunkIndex: c.sectionChunkIndex,
        sectionChunkTotal: c.sectionChunkTotal,
        edited: c.preserved,
        // 人工编辑搬回来了 → 保留「谁改的 / 什么时候」
        editedBy: c.preserved ? (old?.editedBy ?? null) : null,
        editedAt: c.preserved ? (old?.editedAt ?? null) : null,
      };
    }),
  );
}

/** 删掉一篇文档的块行（删文档时一起清） */
export async function deleteChunks(tenantId: string, documentId: string): Promise<void> {
  if (!chunkStoreAvailable) {
    return;
  }
  await DocumentChunk.destroy({
    where: { tenant_id: tenantId, document_id: documentId },
  });
}

// ===== 文本拆分 / 合并 =====

/**
 * 把块文本拆成「面包屑 + 正文」。
 *
 * 块的完整文本 = `面包屑 \n\n 重叠区 \n\n 正文`（用 SEP 拼），
 * 所以第一段就是面包屑（没有标题路径时面包屑只有文档标题）。
 */
export function splitBreadcrumb(text: string): { breadcrumb: string; content: string } {
  const idx = text.indexOf(SEP);
  if (idx < 0) {
    return { breadcrumb: '', content: text };
  }
  return { breadcrumb: text.slice(0, idx), content: text.slice(idx + SEP.length) };
}

/**
 * 在指定位置把一块拆成两块。
 *
 * @param at 拆分的字符位置（相对**整块文本**）
 *
 * ⚠️ **两块都带同样的面包屑** —— 拆出来的第二块如果没面包屑，
 *    它的向量里就没有「自己在哪一节」的信息，检索时跟裸正文没区别。
 */
export function splitChunkText(text: string, at: number): { left: string; right: string } {
  const { breadcrumb, content } = splitBreadcrumb(text);
  const offset = breadcrumb === '' ? at : at - (breadcrumb.length + SEP.length);
  const cut = Math.max(0, Math.min(offset, content.length));

  const leftContent = content.slice(0, cut).trim();
  const rightContent = content.slice(cut).trim();
  if (leftContent === '' || rightContent === '') {
    throw new ValidationError('拆分位置落在空白处 —— 拆出来的两块都得有正文');
  }
  const left = breadcrumb === '' ? leftContent : `${breadcrumb}${SEP}${leftContent}`;
  const right = breadcrumb === '' ? rightContent : `${breadcrumb}${SEP}${rightContent}`;
  return { left, right };
}

/**
 * 把几块合并成一块。
 *
 * ⚠️ **只有第一块的面包屑保留** —— 后面的块的面包屑跟第一块一样，
 *    重复一遍是纯噪声 token。
 */
export function mergeChunkTexts(texts: string[]): string {
  if (texts.length === 0) {
    throw new ValidationError('没有可合并的块');
  }
  const parts = texts.map(splitBreadcrumb);
  const breadcrumb = parts[0]?.breadcrumb ?? '';
  const contents = parts.map((p) => p.content.trim()).filter((c) => c !== '');
  if (contents.length === 0) {
    throw new ValidationError('选中的块正文都是空的，合不了');
  }
  const merged = contents.join(SEP);
  return breadcrumb === '' ? merged : `${breadcrumb}${SEP}${merged}`;
}

// ===== 审计 =====

/** 写审计（编辑类操作全部留痕） */
export async function auditChunkEdit(params: {
  tenantId: string;
  userId: string | null;
  documentId: string;
  documentTitle: string;
  action: 'DOCUMENT_CHUNK_EDITED' | 'DOCUMENT_CHUNK_SPLIT' | 'DOCUMENT_CHUNK_MERGED' | 'DOCUMENT_CHUNK_RESET';
  details: Record<string, unknown>;
  ip?: string | undefined;
}): Promise<void> {
  await writeAuditLog({
    tenant_id: params.tenantId,
    user_id: params.userId,
    action: params.action,
    resource_type: 'document_chunk',
    resource_id: params.documentId,
    details: {
      document_title: params.documentTitle,
      ...params.details,
    },
    ip: params.ip ?? null,
  });
}
