import { splitByChunk } from './chunk';
import { embedBatch } from './embedding';
import { bm25Add } from './bm25';
import { upsertDocumentChunks, ensureCollection } from './qdrant';
import { logger } from '../logger';

/**
 * 文档索引主流程 —— 详见 docs/05-b-数据模型-qdrant.md §5.6.6 完整 RAG 数据流
 *
 *   拆块 → 批量 Embedding → 写 Qdrant → 写 BM25 内存索引
 *
 * **同步执行**：调用方（上传路由）在同一个请求里跑完，成功后回填
 * documents.status='ready' + chunk_count，失败则置 'failed'。
 * 大文档会占住 HTTP 连接，将来要改异步时把本函数包成队列任务即可，业务代码不用动。
 *
 * **失败时的残留**：Qdrant 写了一半失败会留下部分点，但 `upsertDocumentChunks` 每次开头
 * 都先按 doc_id 删旧点，所以「重试索引」永远从干净状态开始，不会出现新旧块混杂。
 * BM25 同理（bm25Add 先按 doc_id 删）。
 */

export interface IngestParams {
  documentId: string;
  tenantId: string;
  title: string;
  /** 解析后的全文（PDF/MD/TXT 的纯文本） */
  text: string;
}

export interface IngestResult {
  chunkCount: number;
}

export async function ingestDocument(params: IngestParams): Promise<IngestResult> {
  const chunks = splitByChunk(params.text);
  if (chunks.length === 0) {
    throw new Error('文档解析后为空（提取不到任何文本，可能是扫描件 PDF 或纯图片）');
  }

  try {
    await ensureCollection();

    const vectors = await embedBatch(chunks.map((c) => c.text));

    await upsertDocumentChunks({
      docId: params.documentId,
      tenantId: params.tenantId,
      title: params.title,
      chunks: chunks.map((c) => ({ index: c.index, text: c.text })),
      vectors,
    });

    // BM25 是第二路召回，挂了不影响向量结果 —— 记 warn 不抛
    try {
      bm25Add({
        tenantId: params.tenantId,
        chunks: chunks.map((c) => ({
          doc_id: params.documentId,
          chunk_index: c.index,
          source: params.title,
          text: c.text,
        })),
      });
    } catch (err: unknown) {
      logger.warn(
        {
          docId: params.documentId,
          err: err instanceof Error ? err.message : String(err),
        },
        'BM25 索引写入失败（向量检索不受影响，重启后会从 Qdrant 重建）',
      );
    }

    logger.info(
      { docId: params.documentId, tenantId: params.tenantId, chunks: chunks.length },
      '文档索引完成',
    );
    return { chunkCount: chunks.length };
  } catch (err: unknown) {
    const e = err as { name?: string; message?: string; status?: number };
    logger.error(
      {
        stage: 'ingestDocument',
        docId: params.documentId,
        name: e.name ?? null,
        message: e.message ?? String(err),
        status: e.status ?? null,
      },
      '文档索引失败',
    );
    throw err;
  }
}