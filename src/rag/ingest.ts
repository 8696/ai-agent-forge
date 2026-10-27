import { applyPreservedEdits, splitByElements, type Chunk, type PreservedEdit } from './chunk';
import { buildElements } from './elements';
import { embedBatch } from './embedding';
import { bm25Add } from './bm25';
import { resolveEmbedding } from '../config';
import { upsertDocumentChunks, ensureCollection, type ExistingChunkVector } from './qdrant';
import { logger } from '../logger';
import type { DocumentFileType } from '../models';

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
  /** 文件类型 —— 决定用哪种结构解析（Markdown 走 AST，PDF 按页，TXT 按段） */
  fileType: DocumentFileType;
  /** PDF 每页的文本（保住页边界这个结构信号） */
  pageTexts?: string[] | undefined;
  /**
   * 重新索引时要**保留**的人工编辑（services 层从 DB 读出来传进来）。
   *
   * ⚠️ 不传 = 全部丢掉 —— 重新索引就是「回到当前切法的原始切块」。
   */
  preservedEdits?: PreservedEdit[] | undefined;
  /**
   * 旧块（文本 + 向量）—— **复用没变的块的向量**，省下白扔的 embedding 调用。
   *
   * ⚠️ 调用方必须在写回之前把它取出来（写回会先删掉旧点）。
   */
  existingChunks?: ExistingChunkVector[] | undefined;
}

export interface IngestResult {
  chunkCount: number;
  /** 人工编辑里有多少条**没能**搬回来（切法变了，对不上） */
  unmatchedEdits: number;
  /** 这次真正新算的向量数 */
  embedded: number;
  /** 复用了旧向量的块数（省下的 embedding 调用） */
  reused: number;
  /** 每个块的详情（写 DB 权威副本用） */
  chunks: IngestedChunk[];
}

/** 索引产出的一个块（写 DB 用） */
export interface IngestedChunk {
  index: number;
  /** 最终文本（人工编辑已应用）—— 进向量的就是它 */
  text: string;
  /** 由程序生成的文本（人工编辑之前）—— 「还原」的依据 */
  generatedText: string;
  headingPath: string[];
  /** 在归一化原文里的区间 */
  charStart: number;
  charEnd: number;
  sectionChunkIndex: number;
  sectionChunkTotal: number;
  /** 人工编辑有没有被搬回来 */
  preserved: boolean;
}

/**
 * 要写回向量库的一块。
 *
 * 比 `Chunk` 松 —— **编辑之后 DB 里只有这些字段**，
 * 元素类型分布（`elementTypes`）在编辑之后就失真了，不该再带出去。
 */
export interface ChunkToWrite {
  index: number;
  text: string;
  headingPath: string[];
  sectionChunkIndex: number;
  sectionChunkTotal: number;
}

/**
 * 拆块 → 向量化 → 写 Qdrant → 写 BM25。
 *
 * @throws 解析 / embedding / 写入失败时抛（调用方负责把文档标成 failed）
 */
export async function ingestDocument(params: IngestParams): Promise<IngestResult> {
  try {
    /**
     * 结构感知拆块（2026-10-27 改版）：
     *   解析成元素序列（保住标题 / 列表 / 代码 / 表格 / 页边界）
     *   → 按标题分节 → 节内按元素聚合成块 → 块首拼标题路径面包屑
     *
     * 文档标题进面包屑的最外层 → 每块都知道自己在哪份文档的哪一节。
     */
    const elementDoc = buildElements({
      text: params.text,
      fileType: params.fileType,
      pageTexts: params.pageTexts,
    });
    const rawChunks = splitByElements(elementDoc, { root: [params.title] });

    // 重新索引时把人工编辑搬回新块（按源区间重叠度配对）
    const { chunks: preservedChunks, unmatched } = applyPreservedEdits(
      rawChunks,
      params.preservedEdits ?? [],
    );

    // 搬回来的块：文本被换过（= 人工编辑搬回来了）；其余是程序刚切的
    const chunks: IngestedChunk[] = preservedChunks.map((chunk, i) => {
      const raw = rawChunks[i];
      return {
        index: chunk.index,
        text: chunk.text,
        generatedText: raw?.text ?? chunk.text,
        headingPath: chunk.headingPath,
        charStart: chunk.charStart,
        charEnd: chunk.charEnd,
        sectionChunkIndex: chunk.sectionChunkIndex,
        sectionChunkTotal: chunk.sectionChunkTotal,
        preserved: raw !== undefined && raw.text !== chunk.text,
      };
    });

    const { embedded, reused } = await writeDocumentChunks({
      docId: params.documentId,
      tenantId: params.tenantId,
      title: params.title,
      chunks: chunks.map((c) => ({
        index: c.index,
        text: c.text,
        headingPath: c.headingPath,
        sectionChunkIndex: c.sectionChunkIndex,
        sectionChunkTotal: c.sectionChunkTotal,
      })),
      existing: params.existingChunks,
    });

    logger.info(
      {
        docId: params.documentId,
        tenantId: params.tenantId,
        chunks: chunks.length,
        embedded,
        reused,
        unmatchedEdits: unmatched,
      },
      '文档索引完成',
    );
    return {
      chunkCount: chunks.length,
      unmatchedEdits: unmatched,
      embedded,
      reused,
      chunks,
    };
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

/**
 * 把一批块写回向量库 + BM25 —— **复用没变的块的向量**。
 *
 * ## 为什么复用
 *
 * 一块文本 = 一个向量。改一个字 → 整块向量全变 → 必须重算。
 * 但一篇文档 100 块里只改了 1 块时，另外 99 块的向量**完全不用重算**
 * —— 重算一遍是 99 次白扔的 embedding 调用（钱 + 时间）。
 *
 * ## 复用的判据是**文本相同**，不是序号相同
 *
 * 拆分 / 合块会让后面的块序号整体位移，但文本没变 → 照样能复用。
 *
 * ⚠️ **BM25 是进程内内存索引**（见 src/rag/bm25.ts）——
 *    多实例部署时只有当前实例更新了，其他实例还是旧文本。
 *    这是既有的架构限制（AGENTS.md「已知限制」里记着），不是这里引入的。
 */
export async function writeDocumentChunks(params: {
  docId: string;
  tenantId: string;
  title: string;
  chunks: ChunkToWrite[];
  /** 旧块（文本 + 向量）—— 同文本的块直接复用 */
  existing?: ExistingChunkVector[] | undefined;
}): Promise<{ embedded: number; reused: number }> {
  const { docId, tenantId, title, chunks } = params;
  if (chunks.length === 0) {
    return { embedded: 0, reused: 0 };
  }

  // 旧块：文本 → 向量
  //
  // ⚠️ **只复用「embedding 模型名对得上」的旧向量** ——
  //    换了 embedding 模型但维度没变的话，两套模型的向量混在一起算相似度没有意义
  //    （老点没有 embedding_model 字段 → 当作对不上 → 一律重算）。
  const currentEmbedModel = resolveEmbedding().embedModel;
  const vectorByText = new Map<string, number[]>();
  for (const old of params.existing ?? []) {
    if (old.embeddingModel !== currentEmbedModel) {
      continue;
    }
    if (!vectorByText.has(old.text)) {
      vectorByText.set(old.text, old.vector);
    }
  }

  // 哪些块要新算 —— 文本在旧块里找不到的
  const toEmbed: ChunkToWrite[] = [];
  const vectors: number[][] = [];
  let reused = 0;
  for (const chunk of chunks) {
    const reusedVector = vectorByText.get(chunk.text);
    if (reusedVector !== undefined) {
      vectors.push(reusedVector);
      reused += 1;
    } else {
      toEmbed.push(chunk);
      // 占位，稍后按顺序替换
      vectors.push([]);
    }
  }

  if (toEmbed.length > 0) {
    const fresh = await embedBatch(toEmbed.map((c) => c.text));
    let fi = 0;
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      if (chunk === undefined) {
        continue;
      }
      if (vectorByText.has(chunk.text)) {
        continue;
      }
      const v = fresh[fi];
      fi += 1;
      if (v !== undefined) {
        vectors[i] = v;
      }
    }
  }

  await ensureCollection();
  await upsertDocumentChunks({
    docId,
    tenantId,
    title,
    chunks: chunks.map((c) => ({
      index: c.index,
      text: c.text,
      ...(c.headingPath !== undefined ? { headingPath: c.headingPath } : {}),
      sectionChunkIndex: c.sectionChunkIndex,
      sectionChunkTotal: c.sectionChunkTotal,
    })),
    vectors,
  });

  // BM25 是第二路召回，挂了不影响向量结果 —— 记 warn 不抛
  try {
    bm25Add({
      tenantId,
      chunks: chunks.map((c) => ({
        doc_id: docId,
        chunk_index: c.index,
        source: title,
        text: c.text,
      })),
    });
  } catch (err: unknown) {
    logger.warn(
      {
        docId,
        err: err instanceof Error ? err.message : String(err),
      },
      'BM25 索引写入失败（向量检索不受影响，重启后会从 Qdrant 重建）',
    );
  }

  return { embedded: toEmbed.length, reused };
}
