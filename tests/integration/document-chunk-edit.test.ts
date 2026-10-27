/**
 * tests/integration/document-chunk-edit.test.ts
 *
 * 「人工编辑知识库切片」的端到端 —— 对应
 *   - src/services/document-chunks.ts（编辑服务）
 *   - src/services/document-ingest.ts（索引时写 DB + 保留人工编辑）
 *   - src/rag/chunk.ts（applyPreservedEdits：编辑在重新索引后搬家）
 *   - src/gateway/admin/knowledge-routes.ts 的写端点（跨租户隔离）
 *
 * ## 本文件**不产生 embedding 费用**
 *
 * `src/rag/embedding` 被 mock 掉，走的是「假向量」这条纯本地链路。
 * 假向量的维度取自真实配置（`resolveEmbedding().embedDimensions`）——
 * Qdrant collection 的维度是建 collection 时定死的，对不上会直接 400。
 *
 * ## 前置条件
 *
 *   1. 后端起在 3099（NODE_ENV=test PORT=3099 tsx src/server.ts）
 *   2. 迁移 036（document_chunks 表）已跑 —— 少了这张表编辑功能直接不可用
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Op } from 'sequelize';
import { resolveEmbedding } from '../../src/config';
import { getSequelize } from '../../src/db';
import { Document, Tenant, AuditLog } from '../../src/models';
import { DocumentChunk } from '../../src/models/DocumentChunk';
import { indexDocument, removeDocument } from '../../src/services/document-ingest';
import { saveUpload } from '../../src/services/document-upload';
import {
  auditChunkEdit,
  ensureChunkRows,
  loadChunks,
  mergeChunkTexts,
  probeDocumentChunksTable,
  saveChunks,
  splitChunkText,
} from '../../src/services/document-chunks';
import { fetchDocChunks, fetchDocChunkVectors } from '../../src/rag/qdrant';

// ⚠️ mock 必须打在**被测模块的导入之前**（vitest 会把 vi.mock 提到文件顶部）。
vi.mock('../../src/rag/embedding', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/rag/embedding')>();
  const dim = resolveEmbedding().embedDimensions;
  /** 一个确定性的假向量：同样的文本永远得到同样的向量 */
  const fake = (text: string): number[] => {
    const vector = new Array<number>(dim).fill(0);
    // 用文本长度散到不同的轴上 —— 不同文本的向量不一样（够用了）
    vector[text.length % dim] = 1;
    vector[0] = 0.5;
    return vector;
  };
  return {
    ...actual,
    embedBatch: vi.fn(async (texts: readonly string[]) => texts.map(fake)),
    embedOne: vi.fn(async (text: string) => fake(text)),
  };
});

const TMP_DIR = path.resolve(process.cwd(), 'data', 'tmp');
const MARKER = `切片编辑测试${Date.now()}`;

const ACME = { tenantId: '', tenantCode: 'acme' };

/** 建一篇 Markdown 文档并索引（走真实的服务层） */
async function createIndexedDocument(tenantId: string, title: string): Promise<Document> {
  const body = [
    `# ${title}`,
    '',
    '## 七天无理由退货',
    '',
    `${MARKER} 消费者购买商品七日内可以无理由退货，商品需保持完好。`,
    '',
    '## 退款到账时间',
    '',
    '退款审核通过后，款项将在三到五个工作日内原路退回。',
    '',
    '## 不支持无理由退货的商品',
    '',
    '定制商品、鲜活易腐商品以及拆封的音像制品不支持无理由退货。',
    '',
  ].join('\n');

  await fs.mkdir(TMP_DIR, { recursive: true });
  const tmpPath = path.join(TMP_DIR, `chunk-edit-${Date.now()}.md`);
  await fs.writeFile(tmpPath, body, 'utf8');

  const saved = await saveUpload({ tmpPath, originalFilename: `${title}.md`, tenantId });
  const doc = await Document.create({
    tenant_id: tenantId,
    title: saved.title,
    source: saved.source,
    file_type: saved.fileType,
    file_path: saved.absolutePath,
    status: 'indexing',
    uploaded_by: null,
    metadata: { bytes: saved.bytes },
  });

  const outcome = await indexDocument(doc, { tenantId, uploadedBy: null, via: 'admin' });
  expect(outcome.status).toBe(201);
  return doc;
}

describe('切片编辑（人工改知识库内容）', () => {
  let doc: Document;

  beforeAll(async () => {
    const sequelize = getSequelize();
    await sequelize.authenticate();
    // 模拟服务端启动时的探针（生产里在 initDatabase 里调）
    await probeDocumentChunksTable();
    const tenant = await Tenant.findOne({ where: { code: ACME.tenantCode } });
    if (tenant === null) {
      throw new Error('测试租户 acme 不存在（先跑 yarn seed）');
    }
    ACME.tenantId = tenant.id;
    doc = await createIndexedDocument(ACME.tenantId, `${MARKER}-文档`);
  });

  afterAll(async () => {
    // ⚠️ **按标题前缀清理** —— 不是只删 `doc`：
    //    测试中途失败时（比如断言先炸了），后面建的文档会留在库里，
    //    一次跑测就能攒出一堆「切片编辑测试xxx」垃圾文档。
    const leftovers = await Document.findAll({
      where: { tenant_id: ACME.tenantId, title: { [Op.like]: `${MARKER}%` } },
    });
    for (const leftover of leftovers) {
      await removeDocument(leftover, ACME.tenantId).catch(() => undefined);
    }
  });

  it('索引完成后，DB 里有这份文档的切片副本（权威副本）', async () => {
    const rows = await loadChunks(ACME.tenantId, doc.id);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBe(doc.chunk_count);
    // 每行都有标题路径（面包屑的来源）
    expect(rows.every((r) => r.headingPath !== null)).toBe(true);
    // 刚索引出来的块**没有**被人工编辑过
    expect(rows.every((r) => r.edited === false)).toBe(true);
  });

  it('Qdrant 里的块和 DB 里的块一一对应', async () => {
    const q = await fetchDocChunks({ docId: doc.id, tenantId: ACME.tenantId, pageSize: 100 });
    const rows = await loadChunks(ACME.tenantId, doc.id);
    expect(q.total).toBe(rows.length);
    const texts = new Set(rows.map((r) => r.text));
    for (const chunk of q.chunks) {
      expect(texts.has(chunk.text)).toBe(true);
    }
  });

  it('改一块 → DB 和向量库都更新，且只有被改的那块重算了向量', async () => {
    const rows = await loadChunks(ACME.tenantId, doc.id);
    const target = rows[0];
    expect(target).toBeDefined();
    const index = target?.chunkIndex ?? 0;

    const before = await fetchDocChunkVectors({ docId: doc.id, tenantId: ACME.tenantId });
    const newText = `${target?.text ?? ''}\n\n人工补充：节假日期间也受理退货申请。`;

    target!.text = newText;
    target!.edited = true;
    target!.editedBy = 'test-user';
    target!.editedAt = new Date();
    await saveChunks(ACME.tenantId, doc.id, rows.map((r) => ({
      chunkIndex: r.chunkIndex,
      text: r.text,
      generatedText: r.generatedText,
      headingPath: r.headingPath,
      sourceCharStart: r.sourceCharStart,
      sourceCharEnd: r.sourceCharEnd,
      sectionChunkIndex: r.sectionChunkIndex,
      sectionChunkTotal: r.sectionChunkTotal,
      edited: r.edited,
      editedBy: r.editedBy,
      editedAt: r.editedAt,
    })));

    // 重新向量化（复用没变的块的向量）
    const { writeDocumentChunks } = await import('../../src/rag/ingest');
    const stats = await writeDocumentChunks({
      docId: doc.id,
      tenantId: ACME.tenantId,
      title: doc.title,
      chunks: rows.map((r) => ({
        index: r.chunkIndex,
        text: r.text,
        headingPath: r.headingPath ?? [],
        sectionChunkIndex: r.sectionChunkIndex,
        sectionChunkTotal: r.sectionChunkTotal,
      })),
      existing: before,
    });
    // 只有被改的那一块需要重新算向量
    expect(stats.embedded).toBe(1);
    expect(stats.reused).toBe(rows.length - 1);

    // 向量库里的文本同步了
    const after = await fetchDocChunks({ docId: doc.id, tenantId: ACME.tenantId, pageSize: 100 });
    const hit = after.chunks.find((c) => c.chunk_index === index);
    expect(hit?.text).toBe(newText);
  });

  it('拆分 → 块数 +1，两块都带同样的面包屑', async () => {
    const rows = await loadChunks(ACME.tenantId, doc.id);
    const target = rows[0];
    expect(target).toBeDefined();
    const before = rows.length;

    const { left, right } = splitChunkText(target!.text, target!.text.length - 5);
    const next = [
      { ...target!, text: left, generatedText: left },
      { ...target!, chunkIndex: target!.chunkIndex + 1, text: right, generatedText: right },
      ...rows.slice(1).map((r, i) => ({ ...r, chunkIndex: r.chunkIndex + 1 + i })),
    ].map((r, i) => ({ ...r, chunkIndex: i }));

    expect(next.length).toBe(before + 1);
    const first = next[0];
    const second = next[1];
    expect(first?.text.split('\n\n')[0]).toBe(second?.text.split('\n\n')[0]);
  });

  it('合并 → 只保留第一块的面包屑', () => {
    const merged = mergeChunkTexts([
      '手册 > 退款\n\n第一块。',
      '手册 > 退款\n\n第二块。',
    ]);
    expect(merged.split('\n\n')[0]).toBe('手册 > 退款');
    expect(merged).toContain('第一块。');
    expect(merged).toContain('第二块。');
  });

  it('重新索引 → 人工编辑被保留下来（不会被静默吃掉）', async () => {
    const rows = await loadChunks(ACME.tenantId, doc.id);
    // 改其中一块
    const target = rows[0];
    expect(target).toBeDefined();
    const editedText = `${target!.text}\n\n【人工标记】这一句是人工加的。`;
    target!.text = editedText;
    target!.edited = true;
    target!.editedBy = 'test-user';
    target!.editedAt = new Date();
    await saveChunks(ACME.tenantId, doc.id, rows.map((r) => ({
      chunkIndex: r.chunkIndex,
      text: r.text,
      generatedText: r.generatedText,
      headingPath: r.headingPath,
      sourceCharStart: r.sourceCharStart,
      sourceCharEnd: r.sourceCharEnd,
      sectionChunkIndex: r.sectionChunkIndex,
      sectionChunkTotal: r.sectionChunkTotal,
      edited: r.edited,
      editedBy: r.editedBy,
      editedAt: r.editedAt,
    })));

    // 重新索引
    const outcome = await indexDocument(doc, { tenantId: ACME.tenantId, uploadedBy: null, via: 'admin' });
    expect(outcome.status).toBe(201);

    const after = await loadChunks(ACME.tenantId, doc.id);
    const kept = after.find((r) => r.text.includes('【人工标记】'));
    expect(kept).toBeDefined();
    expect(kept?.edited).toBe(true);
  });

  it('跨租户读不到别的租户的切片副本', async () => {
    const globex = await Tenant.findOne({ where: { code: 'globex' } });
    expect(globex).not.toBeNull();
    const rows = await loadChunks(globex!.id, doc.id);
    expect(rows).toHaveLength(0);
  });

  it('删文档 → 切片副本一起清掉', async () => {
    const tmp = await createIndexedDocument(ACME.tenantId, `${MARKER}-待删`);
    expect((await loadChunks(ACME.tenantId, tmp.id)).length).toBeGreaterThan(0);
    await removeDocument(tmp, ACME.tenantId);
    expect(await loadChunks(ACME.tenantId, tmp.id)).toHaveLength(0);
  });

  it('老文档（没有 DB 副本）→ 编辑时从 Qdrant 补一份', async () => {
    const tmp = await createIndexedDocument(ACME.tenantId, `${MARKER}-老文档`);
    // 模拟「迁移 036 之前索引的文档」—— 块只在 Qdrant 里，DB 没有副本
    await DocumentChunk.destroy({ where: { tenant_id: ACME.tenantId, document_id: tmp.id } });
    expect(await loadChunks(ACME.tenantId, tmp.id)).toHaveLength(0);

    // 编辑前先补一份（编辑端点里调的就是这个）
    const rows = await ensureChunkRows(ACME.tenantId, tmp);
    expect(rows.length).toBeGreaterThan(0);
    // 补出来的块**没被人工改过**
    expect(rows.every((r) => r.edited === false)).toBe(true);
    // 再调一次不会重复补
    const again = await ensureChunkRows(ACME.tenantId, tmp);
    expect(again.length).toBe(rows.length);
  });

  it('切片编辑留审计（谁改的、什么时候）', async () => {
    await auditChunkEdit({
      tenantId: ACME.tenantId,
      userId: 'test-user',
      documentId: doc.id,
      documentTitle: doc.title,
      action: 'DOCUMENT_CHUNK_EDITED',
      details: { chunk_index: 0 },
    });
    const rows = await AuditLog.findAll({
      where: { tenant_id: ACME.tenantId, action: 'DOCUMENT_CHUNK_EDITED', resource_id: doc.id },
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.user_id).toBe('test-user');
  });

  it('表存在性探针：document_chunks 表在 → 编辑功能可用', async () => {
    const { isChunkStoreAvailable } = await import('../../src/services/document-chunks');
    expect(isChunkStoreAvailable()).toBe(true);
    // 模型已注册（能被查）
    expect(await DocumentChunk.count()).toBeGreaterThan(0);
  });
});
