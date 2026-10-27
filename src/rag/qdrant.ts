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
  /**
   * 该块所属的标题层级路径（如 `['产品手册', '退款政策']`）。
   *
   * 2026-10-27 加的 —— 结构感知切块之后，块带上了「自己在文档哪一节」的信息。
   * 后台「切片浏览」页要按这个分组展示，排查「标题有没有被劈开」全靠它。
   *
   * ⚠️ **可选字段**：改切法之前入库的老块没有这个字段（读出来是 undefined），
   *    老文档重新索引之后才会有。
   */
  heading_path?: string[];
  /**
   * 该块是**本节**的第几块（1 起）/ 本节一共几块。
   *
   * 2026-10-27 加 —— 同一节被切成 N 块时，各块的面包屑一模一样，
   * 光看文本分不出先后。检索结果里带上这个，模型才知道「这是长章节的中间部分」。
   *
   * ⚠️ **可选字段**：老块没有（读出来 undefined）。
   */
  section_chunk_index?: number;
  section_chunk_total?: number;
  /**
   * 生成这个向量的 **embedding 模型名**。
   *
   * ⚠️ **不是冗余字段**：换 embedding 模型后旧向量作废 —— 两套模型的向量混在一起
   *    算相似度没有意义。编辑 / 重新索引时**复用旧向量**前要核对模型名对不对
   *    （见 `src/rag/ingest.ts` 的 `writeDocumentChunks`）。
   *
   * ⚠️ **可选字段**：2026-10-27 之前入库的点没有这个字段 → 复用时当作「对不上」，
   *    一律重新算（安全）。
   */
  embedding_model?: string;
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
    await ensurePayloadIndexes();
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

  await ensurePayloadIndexes();
  logger.info(
    { collection: name, dimensions: embedDimensions },
    'Qdrant collection 已创建',
  );
}

/**
 * payload 索引 —— **每个进程只保证一次**。
 *
 * ⚠️ **2026-10-27 修的坑**：以前索引只在「collection 刚建好」的时候建，
 *    于是**已存在的 collection 永远拿不到这些索引** ——
 *    本项目自己建的 collection 一直就是「有 `tenant_id` 索引、没有 `doc_id` 索引」的状态。
 *    后果：按 doc_id 拉块走的是全扫（数据量一大就慢）。
 *
 * ⚠️ **`chunk_index` 的 integer 索引是 `order_by` 的硬前提**：
 *    Qdrant 的「按 payload 字段排序」要求该字段有 **range 索引**，
 *    没有就直接 400（`No range index for order_by key`）。
 *    后台「切片浏览」页要按块序号排出来，就靠这个索引。
 */
let payloadIndexesEnsured = false;

async function ensurePayloadIndexes(): Promise<void> {
  if (payloadIndexesEnsured) {
    return;
  }
  const qdrant = getQdrant();
  const name = config.QDRANT_COLLECTION;
  const indexes = [
    { field: 'tenant_id', schema: 'keyword' },
    { field: 'doc_id', schema: 'keyword' },
    { field: 'chunk_index', schema: 'integer' },
  ] as const;

  for (const { field, schema } of indexes) {
    try {
      await qdrant.createPayloadIndex(name, { field_name: field, field_schema: schema });
      logger.info({ field, schema }, 'Qdrant payload 索引已创建');
    } catch (err: unknown) {
      // 已经有同名索引了 = 正是我们要的结果
      if (!isAlreadyExists(err)) {
        throw err;
      }
    }
  }
  payloadIndexesEnsured = true;
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
  chunks: Array<{
    index: number;
    text: string;
    headingPath?: string[];
    sectionChunkIndex?: number;
    sectionChunkTotal?: number;
  }>;
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
      ...(chunk.headingPath !== undefined ? { heading_path: chunk.headingPath } : {}),
      ...(chunk.sectionChunkIndex !== undefined
        ? { section_chunk_index: chunk.sectionChunkIndex }
        : {}),
      ...(chunk.sectionChunkTotal !== undefined
        ? { section_chunk_total: chunk.sectionChunkTotal }
        : {}),
      // 生成这个向量的模型名 —— 换模型后旧向量不能复用（见 writeDocumentChunks）
      embedding_model: resolveEmbedding().embedModel,
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

/** 一篇文档的块（后台「切片浏览」页要展示的东西） */
export interface DocChunkView {
  chunk_index: number;
  text: string;
  source: string;
  /**
   * 标题层级路径（如 `['产品手册', '退款政策']`）。
   * 老块（结构感知切块之前入库的）没有这个字段 → null。
   */
  heading_path: string[] | null;
  /** 该块是本节第几块（1 起）；老块没有 → null */
  section_chunk_index: number | null;
  /** 本节一共几块；老块没有 → null */
  section_chunk_total: number | null;
  updated_at: number;
}

export interface FetchDocChunksResult {
  chunks: DocChunkView[];
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
}

/**
 * 按文档拉块 —— **诊断用途**（后台「切片浏览」页）。
 *
 * ⚠️ **tenant_id 必须一起过滤** —— 跟向量检索同一条铁律，跨租户 = 泄露。
 *    调用方还要先在 MySQL 里确认文档归属（`findOwnedDocument`），
 *    两道闸缺一不可：DB 那一道管「这个 id 是不是你的」，Qdrant 这一道管「别把别人的块捞出来」。
 * ⚠️ `doc_id` 上有 keyword payload index（`ensurePayloadIndexes` 建的）→ 走索引点查，不是全扫。
 *
 * ## 分页是怎么做的（Qdrant 的两个坑）
 *
 * ① **`offset` 不能和 `order_by` 同用** → 翻页只能用 `order_by.start_from`（payload 值）
 * ② **`order_by` 要求该字段有 range 索引**（`chunk_index` 的 integer 索引，见
 *    `ensurePayloadIndexes`）；索引是后台异步建的，刚建完的那一小段时间里
 *    `order_by` 仍可能报 400 → **兜底退回「拉全量 + 内存排序」**（见下面）
 *
 * ③ `start_from` 是「含」还是「不含」，各版本说法不一 →
 *    这里**故意从 `页首 - 1` 开始多拿一条**，再按「第一条是不是游标本身」对齐，
 *    两种语义都能拿到正确的那一页。
 */
export async function fetchDocChunks(params: {
  docId: string;
  tenantId: string;
  page?: number;
  pageSize?: number;
}): Promise<FetchDocChunksResult> {
  const qdrant = getQdrant();
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(Math.max(1, params.pageSize ?? 20), 100);

  const filter = {
    must: [
      { key: 'doc_id', match: { value: params.docId } },
      { key: 'tenant_id', match: { value: params.tenantId } },
    ],
  };

  const pageStart = (page - 1) * pageSize;
  const cursor = pageStart - 1;

  const counted = await qdrant.count(config.QDRANT_COLLECTION, { filter, exact: true });
  const total = counted.count;

  let points = await scrollChunkPoints({ filter, page, pageSize, cursor });
  /** 取哪一段：正常路径 points 已经是当页了，兜底路径是全量列表 */
  let offsetInList = 0;
  if (points === null) {
    // order_by 不可用（range 索引还没建好）→ 退回「拉全量 + 内存排序」
    logger.warn(
      { docId: params.docId },
      'Qdrant 按 chunk_index 排序失败（range 索引可能还没建好），退回内存排序',
    );
    points = await scrollAllChunkPoints({ filter });
    offsetInList = pageStart;
  }

  const pagePoints = points.slice(offsetInList, offsetInList + pageSize);
  const chunks = pagePoints.flatMap((point) => {
    const payload = point.payload as Partial<ChunkPayload> | undefined;
    if (
      payload === undefined ||
      typeof payload.chunk_index !== 'number' ||
      typeof payload.text !== 'string'
    ) {
      return [];
    }
    return [
      {
        chunk_index: payload.chunk_index,
        text: payload.text,
        source: typeof payload.source === 'string' ? payload.source : params.docId,
        heading_path: Array.isArray(payload.heading_path) ? payload.heading_path : null,
        section_chunk_index:
          typeof payload.section_chunk_index === 'number' ? payload.section_chunk_index : null,
        section_chunk_total:
          typeof payload.section_chunk_total === 'number' ? payload.section_chunk_total : null,
        updated_at: typeof payload.updated_at === 'number' ? payload.updated_at : 0,
      },
    ];
  });

  return {
    chunks,
    total,
    page,
    page_size: pageSize,
    total_pages: Math.ceil(total / pageSize),
  };
}

/** Qdrant 返回的一个点（只取用得到的字段） */
interface ScrolledPoint {
  payload: unknown;
}

/** 一篇文档的「块 + 向量」对（编辑时用来复用没变的块的向量） */
export interface ExistingChunkVector {
  chunkIndex: number;
  text: string;
  vector: number[];
  /** 生成这个向量的 embedding 模型名（老点没有 → undefined） */
  embeddingModel?: string | undefined;
}

/**
 * 取一篇文档全部块的向量 —— **按 chunk_index 索引**。
 *
 * ## 用途：编辑 / 重新索引时**复用没变的块的向量**
 *
 * 一块文本 = 一个向量（见 src/rag/embedding.ts）—— 改一个字，整块向量全变，
 * 必须重算。但一篇文档 100 块里只改了 1 块时，另外 99 块的向量**完全不用重算**
 * —— 重算一遍是 99 次白扔的 embedding 调用（钱 + 时间）。
 *
 * ⚠️ **复用是安全的**：Qdrant collection 的维度是建 collection 时定死的，
 *    旧点的向量维度必然跟当前 collection 一致。
 *    换 embedding 模型本来就必须重建 collection（那时旧点已经没了）。
 *
 * ⚠️ **tenant_id 必须一起过滤** —— 同 fetchDocChunks，跨租户 = 泄露。
 */
export async function fetchDocChunkVectors(params: {
  docId: string;
  tenantId: string;
}): Promise<ExistingChunkVector[]> {
  const qdrant = getQdrant();
  const filter = {
    must: [
      { key: 'doc_id', match: { value: params.docId } },
      { key: 'tenant_id', match: { value: params.tenantId } },
    ],
  };
  const out: ExistingChunkVector[] = [];
  let offset: number | string | undefined;
  const PAGE = 64;

  do {
    const page = await qdrant.scroll(config.QDRANT_COLLECTION, {
      filter,
      limit: PAGE,
      ...(offset === undefined ? {} : { offset }),
      with_payload: true,
      with_vector: true,
    });
    for (const point of page.points as Array<{ payload?: unknown; vector?: unknown }>) {
      const payload = point.payload as Partial<ChunkPayload> | undefined;
      const vector = point.vector;
      if (
        payload === undefined ||
        typeof payload.chunk_index !== 'number' ||
        typeof payload.text !== 'string' ||
        !Array.isArray(vector)
      ) {
        continue;
      }
      out.push({
        chunkIndex: payload.chunk_index,
        text: payload.text,
        vector: vector as number[],
        embeddingModel:
          typeof payload.embedding_model === 'string' ? payload.embedding_model : undefined,
      });
    }
    const next = page.next_page_offset;
    offset = typeof next === 'string' || typeof next === 'number' ? next : undefined;
  } while (offset !== undefined);

  return out;
}

/**
 * 按 `chunk_index` 升序取一页。`order_by` 不可用时返回 null（交给调用方兜底）。
 */
async function scrollChunkPoints(params: {
  filter: { must: Array<{ key: string; match: { value: string } }> };
  page: number;
  pageSize: number;
  cursor: number;
}): Promise<ScrolledPoint[] | null> {
  const { page, pageSize, cursor } = params;
  const orderBy =
    page === 1
      ? { key: 'chunk_index', direction: 'asc' as const }
      : { key: 'chunk_index', direction: 'asc' as const, start_from: cursor };

  let scrolled;
  try {
    scrolled = await getQdrant().scroll(config.QDRANT_COLLECTION, {
      filter: params.filter,
      // 第 2 页起多拿一条：用来判断 start_from 是不是「含」的
      limit: page === 1 ? pageSize : pageSize + 1,
      order_by: orderBy,
      with_payload: true,
      with_vector: false,
    });
  } catch (err: unknown) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Qdrant scroll 失败');
    return null;
  }

  const points = scrolled.points as ScrolledPoint[];
  if (page === 1) {
    return points;
  }
  // start_from 是「含」→ 第一条就是游标本身，丢掉它；是「不含」→ 第一条已经在游标之后，留着
  const first = points[0];
  const firstIndex =
    first === undefined
      ? null
      : ((first.payload as Partial<ChunkPayload> | undefined)?.chunk_index ?? null);
  return firstIndex === cursor ? points.slice(1) : points;
}

/** 兜底：拉这篇文档的全部块，在内存里按 chunk_index 排序 */
async function scrollAllChunkPoints(params: {
  filter: { must: Array<{ key: string; match: { value: string } }> };
}): Promise<ScrolledPoint[]> {
  const qdrant = getQdrant();
  const all: ScrolledPoint[] = [];
  let offset: number | string | undefined;
  const PAGE = 256;

  do {
    const page = await qdrant.scroll(config.QDRANT_COLLECTION, {
      filter: params.filter,
      limit: PAGE,
      ...(offset === undefined ? {} : { offset }),
      with_payload: true,
      with_vector: false,
    });
    all.push(...(page.points as ScrolledPoint[]));
    const next = page.next_page_offset;
    offset = typeof next === 'string' || typeof next === 'number' ? next : undefined;
  } while (offset !== undefined);

  return all.sort((a, b) => {
    const ai = (a.payload as Partial<ChunkPayload> | undefined)?.chunk_index ?? 0;
    const bi = (b.payload as Partial<ChunkPayload> | undefined)?.chunk_index ?? 0;
    return ai - bi;
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