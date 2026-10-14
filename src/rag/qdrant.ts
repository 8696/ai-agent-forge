import { QdrantClient } from '@qdrant/js-client-rest';
import { config, resolveEmbedding } from '../config';
import { logger } from '../logger';

/**
 * Qdrant 客户端 + Collection 自举 —— 详见 docs/05-b-数据模型-qdrant.md §5.6
 *
 * 设计要点：
 *  - Qdrant 走 REST 协议（@qdrant/js-client-rest），不引 OpenTelemetry
 *  - Collection 在首次调用时自举创建（id 用 `${docId}-${chunkIndex}`，避免跨文档冲突）
 *  - payload 必须含 `tenant_id`，搜索时强制按 tenant_id 过滤（防跨租户泄露）
 */

let client: QdrantClient | null = null;

export function getQdrant(): QdrantClient {
  if (client === null) {
    client = new QdrantClient({ url: config.QDRANT_URL });
  }
  return client;
}

/**
 * 确保 collection 存在；存在则 no-op，不存在则按当前 Embedding provider 维度创建
 * 维度来自 `resolveEmbedding().embedDimensions`（per-provider hardcode）。
 * 切换 provider / model 时如果维度变化，必须 **DELETE collection 重建**。
 *
 * 注意：Qdrant 1.x 的 `collectionExists(name)` 返回 `{ exists: boolean }` 而不是裸 boolean。
 */
export async function ensureCollection(): Promise<void> {
  const q = getQdrant();
  const name = config.QDRANT_COLLECTION;
  const res = await q.collectionExists(name);
  if (res.exists === true) {
    logger.debug({ collection: name }, 'Qdrant collection 已存在');
    return;
  }
  const dims = resolveEmbedding().embedDimensions;
  await q.createCollection(name, {
    vectors: {
      size: dims,
      distance: 'Cosine',
    },
    optimizers_config: {},
  });
  await q.createPayloadIndex(name, {
    field_name: 'tenant_id',
    field_schema: 'keyword',
  });
  logger.info({ collection: name, size: dims }, '已创建 Qdrant collection');
}

/**
 * 删一个文档的所有 chunk（按 doc_id 过滤）。
 * 上传失败重试 / 用户删除文档时调。
 */
export async function deleteDocumentPoints(docId: string): Promise<void> {
  const q = getQdrant();
  await q.delete(config.QDRANT_COLLECTION, {
    filter: {
      must: [{ key: 'doc_id', match: { value: docId } }],
    },
  });
}

export interface ScoredPoint {
  doc_id: string;
  chunk_index: number;
  text: string;
  tenant_id: string;
  source: string;
  score: number;
}