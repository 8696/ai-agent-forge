import { randomUUID } from 'node:crypto';
import { splitByChunk } from './chunk';
import { embedBatch, EmbeddingError } from './embedding';
import { getQdrant, ensureCollection, deleteDocumentPoints } from './qdrant';
import { bm25Add } from './bm25';
import { config } from '../config';
import { logger } from '../logger';

/**
 * 文档索引主流程 —— 详见 docs/16-c §C1 + docs/05-b §5.6
 *
 * 同步处理（13-d §13.7 当前 MVP 写法）：分块 + Embedding + 入 Qdrant 全在 API 调用里跑完
 *   - 失败抛 EmbeddingError / Qdrant 错误 → 上层把 documents.status 改成 'failed'
 *   - 成功 → 改 status='ready' + 回填 chunk_count
 *
 * 未来要异步：把 ingestDocument 调用包成 BullMQ 任务，业务代码不动
 *   （参考 13-d §13.7「未来扩展」）
 */

export interface IngestParams {
  documentId: string;
  tenantId: string;
  title: string;
  text: string;
}

export interface IngestResult {
  chunkCount: number;
}

export async function ingestDocument(params: IngestParams): Promise<IngestResult> {
  const chunks = splitByChunk(params.text);
  if (chunks.length === 0) {
    throw new Error('文档解析后为空（无法拆出任何块）');
  }

  try {
    await ensureCollection();
    const q = getQdrant();

    // 1. 先把旧 points 删掉（重试时残留）
    await deleteDocumentPoints(params.documentId).catch((e: unknown) => {
      logger.warn(
        { docId: params.documentId, err: e instanceof Error ? e.message : String(e) },
        '清理旧 Qdrant points 失败（首次上传时正常）',
      );
    });

    // 2. 批量向量化
    const embeddings = await embedBatch(chunks.map((c) => c.text));

    // 3. 入库
    const points = chunks.map((c, i) => {
      const embedding = embeddings[i];
      if (embedding === undefined) {
        throw new EmbeddingError(`chunk ${i} embedding 缺失`);
      }
      return {
        // id 用 randomUUID（Qdrant 1.x 只接受 unsigned integer / UUID）；关联走 payload.doc_id + chunk_index
        id: randomUUID(),
        vector: embedding,
        payload: {
          doc_id: params.documentId,
          chunk_index: c.index,
          text: c.text,
          tenant_id: params.tenantId,
          source: params.title,
          updated_at: Date.now(),
        },
      };
    });

    // 分批 upsert：Qdrant 单次请求体限制 ~1MB，向量多时拆批
    const BATCH = 64;
    for (let i = 0; i < points.length; i += BATCH) {
      await q.upsert(config.QDRANT_COLLECTION, {
        wait: true,
        points: points.slice(i, i + BATCH),
      });
    }

    // BM25 索引增量加入（Step 5 新增）
    // BM25 是次要召回，挂了不影响 vector 路径；warn 即可，不抛错
    try {
      bm25Add({
        tenantId: params.tenantId,
        docId: params.documentId,
        source: params.title,
        chunks: chunks.map((c) => ({ index: c.index, text: c.text, source: params.title })),
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(
        { docId: params.documentId, tenantId: params.tenantId, err: msg },
        'BM25 索引增量加入失败（vector 路径不受影响）',
      );
    }

    logger.info(
      { docId: params.documentId, tenant: params.tenantId, chunks: chunks.length },
      '索引完成',
    );
    return { chunkCount: chunks.length };
  } catch (err: unknown) {
    // 把更详细的信息打出来（stack + status），方便排错
    const e = err as { name?: string; message?: string; stack?: string; status?: number; data?: unknown };
    logger.error(
      {
        stage: 'ingestDocument',
        docId: params.documentId,
        name: e.name ?? null,
        message: e.message ?? String(err),
        status: e.status ?? null,
        data: e.data ?? null,
        stack: e.stack ?? null,
      },
      'ingest 失败',
    );
    throw err;
  }
}