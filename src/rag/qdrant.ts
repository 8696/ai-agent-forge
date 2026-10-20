import { QdrantClient } from '@qdrant/js-client-rest';
import { randomUUID } from 'node:crypto';
import { config, resolveEmbedding } from '../config';
import { logger } from '../logger';

/**
 * Qdrant 向量库封装 —— 详见 docs/05-b-数据模型-qdrant.md §5.6
 *
 * Collection 设计（所有租户共用一个 `documents` collection，靠 payload.tenant_id 隔离）：
 *   - 一个 point = 一个文档块；vector = Embedding API 返回的向量（维度由 provider 决定）
 *   - payload: doc_id / chunk_index / text / tenant_id / source / updated_at
 *   - `tenant_id` 建 keyword payload index，检索时**强制**带这个过滤条件
 *
 * **跨租户隔离是硬约束**：`vectorSearch()` 的 tenantId 参数没有默认值，
 * 调用方拿不到就编译不过，不存在「忘了加 filter」这种可能。
 *
 * 换 embedding 模型 / provider 且维度变了，必须删 collection 重建（docs/06 §6.1.4）。
 */

let client: QdrantClient | null = null;

export function getQdrant(): QdrantClient {
  if (client === null) {
    client = new QdrantClient({ url: config.QDRANT_URL });
  }
  return client;
}

/** 一个 chunk 在 Qdrant 里的 payload 结构（与 docs/05-b §5.6.2 表一致） */
export interface ChunkPayload {
  doc_id: string;
  chunk_index: number;
  text: string;
  tenant_id: string;
  source: string;
  updated_at: number;
}

/** 向量检索命中项 */
export interface VectorHit {
  doc_id: string;
  chunk_index: number;
  text: string;
  source: string;
  /** cosine 相似度，越大越像；Qdrant 返回的原始值，范围 -1 ~ 1 */
  score: number;
}

/**
 * 确保 collection 存在（不存在则按当前 embedding provider 的维度建）。
 *
 * 幂等：上传 / 检索 / 启动重建都调它。并发下多个请求同时建会有一方拿到
 * 「already exists」错误，这里吞掉这种错误——collection 存在本身就是我们要的结果。
 */
export async function ensureCollection(): Promise<void> {
  const qdrant = getQdrant();
  const name = config.QDRANT_COLLECTION;
  const { exists } = await qdrant.collectionExists(name);
  if (exists) {
    return;
  }

  const { embedDimensions } = resolveEmbedding();
  try {
    await qdrant.createCollection(name, {
      vectors: { size: embedDimensions, distance: 'Cosine' },
    });
  } catch (err: unknown) {
    // 并发创建：另一个请求抢先建好了，不算错误
    if (!isAlreadyExists(err)) {
      throw err;
    }
  }

  // tenant_id / doc_id 上建 keyword 索引：没有它，带过滤的检索在数据量大后会退化成全扫
  for (const field of ['tenant_id', 'doc_id'] as const) {
    try {
      await qdrant.createPayloadIndex(name, { field_name: field, field_schema: 'keyword' });
    } catch (err: unknown) {
      if (!isAlreadyExists(err)) {
        throw err;
      }
    }
  }
  logger.info(
    { collection: name, dimensions: embedDimensions },
    'Qdrant collection 就绪',
  );
}

function isAlreadyExists(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /already exists|already_exists/i.test(message);
}

/**
 * 写一个文档的全部 chunk。
 *
 * 先删该 doc_id 的旧点再写：重试索引 / 重新上传同名文档时，
 * 不会留下「上一次的残块」和新块混在一起（那会让检索命中已删除的内容）。
 */
export async function upsertDocumentChunks(params: {
  docId: string;
  tenantId: string;
  title: string;
  chunks: Array<{ index: number; text: string }>;
  vectors: number[][];
}): Promise<void> {
  const { docId, tenantId, title, chunks, vectors } = params;
  if (chunks.length !== vectors.length) {
    throw new Error(`chunk 数(${chunks.length}) 与向量数(${vectors.length}) 不一致`);
  }
  if (chunks.length === 0) {
    return;
  }

  const qdrant = getQdrant();
  await ensureCollection();
  await deleteDocumentPoints(docId);

  const now = Date.now();
  const points = chunks.map((chunk, i) => ({
    // Qdrant point id 只接受 UUID / 无符号整数；跟 documents.id 的关联走 payload.doc_id
    id: randomUUID(),
    vector: vectors[i] as number[],
    payload: {
      doc_id: docId,
      chunk_index: chunk.index,
      text: chunk.text,
      tenant_id: tenantId,
      source: title,
      updated_at: now,
    } satisfies ChunkPayload,
  }));

  // 分批写：Qdrant 单个请求体有上限，大文档（几百块）一次性发会被拒
  const WRITE_BATCH = 64;
  for (let i = 0; i < points.length; i += WRITE_BATCH) {
    await qdrant.upsert(config.QDRANT_COLLECTION, {
      wait: true,
      points: points.slice(i, i + WRITE_BATCH),
    });
  }
  logger.debug({ docId, tenantId, points: points.length }, 'Qdrant 写入完成');
}

/** 删掉某个文档的全部 chunk（重试索引前清理 / 删除文档时用） */
export async function deleteDocumentPoints(docId: string): Promise<void> {
  await getQdrant().delete(config.QDRANT_COLLECTION, {
    wait: true,
    filter: { must: [{ key: 'doc_id', match: { value: docId } }] },
  });
}

/**
 * 向量召回。**tenantId 必填**，filter 在函数内部拼死，调用方无法绕过租户隔离。
 */
export async function vectorSearch(params: {
  tenantId: string;
  vector: number[];
  topK: number;
}): Promise<VectorHit[]> {
  const response = await getQdrant().query(config.QDRANT_COLLECTION, {
    query: { nearest: params.vector },
    filter: { must: [{ key: 'tenant_id', match: { value: params.tenantId } }] },
    limit: params.topK,
    with_payload: true,
  });

  return response.points.flatMap((point) => {
    const payload = point.payload as Partial<ChunkPayload> | undefined;
    if (
      payload === undefined ||
      typeof payload.doc_id !== 'string' ||
      typeof payload.chunk_index !== 'number' ||
      typeof payload.text !== 'string'
    ) {
      // payload 被手工改坏或来自老版本 schema；跳过而不是让整次检索失败
      logger.warn({ pointId: point.id }, 'Qdrant 命中项 payload 缺字段，已跳过');
      return [];
    }
    return [
      {
        doc_id: payload.doc_id,
        chunk_index: payload.chunk_index,
        text: payload.text,
        source: typeof payload.source === 'string' ? payload.source : payload.doc_id,
        score: point.score,
      },
    ];
  });
}

/**
 * 滚动拉取全量 chunk（只取 payload，不取向量）。
 *
 * 用途：进程启动时重建 BM25 内存索引（索引只活在内存里，重启即丢）。
 * 分页拉，避免一次性把整个 collection 的 payload 塞进内存。
 */
export async function scrollAllChunks(
  onChunk: (payload: ChunkPayload) => void,
): Promise<number> {
  const qdrant = getQdrant();
  const PAGE = 256;
  let offset: number | string | undefined;
  let total = 0;

  do {
    const page = await qdrant.scroll(config.QDRANT_COLLECTION, {
      limit: PAGE,
      // offset 省略而不是传 undefined：首屏不需要游标
      ...(offset === undefined ? {} : { offset }),
      with_payload: true,
      with_vector: false,
    });
    for (const point of page.points) {
      const payload = point.payload as Partial<ChunkPayload> | undefined;
      if (
        payload !== undefined &&
        typeof payload.doc_id === 'string' &&
        typeof payload.chunk_index === 'number' &&
        typeof payload.text === 'string' &&
        typeof payload.tenant_id === 'string'
      ) {
        onChunk(payload as ChunkPayload);
        total += 1;
      }
    }
    const next = page.next_page_offset;
    offset = typeof next === 'string' || typeof next === 'number' ? next : undefined;
  } while (offset !== undefined);

  return total;
}

/** collection 里的总点数（文档管理页展示「向量总数」用） */
export async function countPoints(): Promise<number> {
  try {
    const info = await getQdrant().getCollection(config.QDRANT_COLLECTION);
    return info.points_count ?? 0;
  } catch {
    return 0;
  }
}