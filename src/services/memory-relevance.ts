import { resolveEmbedding } from '../config';
import { embedBatch } from '../rag/embedding';
import { logger } from '../logger';
import { UserMemory, type UserMemorySource } from '../models';
import { isMissingColumnError } from '../lib/sql-errors';

/**
 * 记忆的向量召回 —— B4 的「记忆检索」那一项
 * （docs/07-c-模块-rag记忆状态协议.md 模块 10 · docs/12-b-需求-ai对话能力.md §B4）
 *
 * ## 解决什么
 *
 * 原来注入哪几条记忆是**固定顺序**：用户写的 > 管理员写的 > 自动抽的，
 * 同档按置信度、再按更新时间。问题在于「最新」不等于「最相关」——
 * 用户攒了 50 条记忆时，本轮问「报销流程」，排在前面的是**刚写的那条**
 * 「我喜欢简洁的回答」，真正相关的「发票抬头是 XX 公司」排在第 20 位，
 * topK=8 根本轮不到它。
 *
 * 改成：**用当前问题给每条记忆算一次余弦相似度，按相似度排**。
 *
 * ## 存储：为什么是 user_memories 上的一列，不是 Qdrant
 *
 *  - **隔离跟着表走**。`user_memories` 有 tenant_id 列 → Sequelize 的租户作用域钩子
 *    （src/lib/tenant-scope.ts）自动补过滤。向量存在这一行里，就自动继承了隔离。
 *    放 Qdrant 得**重新实现一遍**租户过滤 —— A1 刚把这条硬化成运行时强制，
 *    再手写一遍过滤条件等于给自己开一个跨租户的口子。
 *  - **量级小**。单个用户最多 50 条自动记忆 + 手写的那几条，
 *    几百条向量在 DB 里算余弦是毫秒级，用不上 ANN 索引。
 *  - **不用重建 collection**。换 embedding 模型时只要重算这一列。
 *
 * ## 降级
 *
 * 这一层**任何一步失败都不该让对话挂掉**（记忆是锦上添花）：
 *  - embedding 服务调不通 → 退回固定顺序排序（= 改造前的行为）
 *  - 某条记忆没有向量（刚写的 / 换了 embedding 模型）→ 相关性按 0 算，
 *    跟「有向量但不相关」同档，再由优先级兜底 —— 不会因为缺向量就被饿死
 *  - 列不存在（迁移 035 没跑）→ 整个特性关掉，回到纯固定顺序
 */

/** 存库时保留的小数位 —— 6 位足够保留 float32 精度，JSON 体积还能砍掉一半 */
const EMBEDDING_PRECISION = 6;

/** 来源优先级：用户自己写的 > 管理员写的 > 模型自动抽的 */
const SOURCE_RANK: Record<UserMemorySource, number> = { user: 0, admin: 1, auto: 2 };

/** 列支持状态：'available' = 迁移 035 跑过了；'missing' = 没跑，已降级 */
let embeddingSupport: 'available' | 'missing' = 'available';

/** 上一次补算向量失败的时间 —— 失败后一段时间内不再重试（省掉每轮重复的无效调用） */
let lastBackfillFailureAt = 0;

/** 补算失败后的冷却时间（毫秒） */
const BACKFILL_FAILURE_COOLDOWN_MS = 60_000;

// ============================================================
// 纯函数：向量数学
// ============================================================

/** L2 归一化（零向量原样返回） */
export function normalizeVector(vector: readonly number[]): number[] {
  let sum = 0;
  for (const v of vector) {
    sum += v * v;
  }
  const norm = Math.sqrt(sum);
  if (norm === 0) {
    return vector.map(() => 0);
  }
  return vector.map((v) => v / norm);
}

/**
 * 余弦相似度（-1 ~ 1）。
 *
 * ⚠️ **这里不做阈值判断** —— 不同 embedding 模型「不相关」的相似度基线差很多
 * （bge-m3 随手两句无关的话也有 0.3~0.5），写死阈值换个模型就失效。
 * 只做**相对排序**，阈值交给上层按分布定。
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) {
    return 0;
  }
  const na = normalizeVector(a);
  const nb = normalizeVector(b);
  let dot = 0;
  for (let i = 0; i < na.length; i += 1) {
    dot += (na[i] as number) * (nb[i] as number);
  }
  return dot;
}

/** 优先级比较（相关性相同时用它兜底） */
export function compareMemoryPriority(a: UserMemory, b: UserMemory): number {
  const bySource = SOURCE_RANK[a.source] - SOURCE_RANK[b.source];
  if (bySource !== 0) {
    return bySource;
  }
  const byConfidence = b.confidence - a.confidence;
  if (byConfidence !== 0) {
    return byConfidence;
  }
  return b.updated_at.getTime() - a.updated_at.getTime();
}

/** 把向量存成 JSON 友好的形式（归一化 + 保留 6 位小数） */
export function serializeEmbedding(
  vector: readonly number[],
  model: string,
): { embedding: number[]; embedding_model: string } {
  return {
    embedding: normalizeVector(vector).map((v) => Number(v.toFixed(EMBEDDING_PRECISION))),
    embedding_model: model,
  };
}

/**
 * 读出行上存的向量；读不出来一律返回 null。
 *
 * 返回 null 的三种情况：
 *  - 没存（刚写的 / 补算失败）
 *  - 存的不是合法向量数组
 *  - **模型对不上**（换了 embedding 模型，旧向量作废 —— 混用两套模型的向量算相似度没有意义）
 */
export function readStoredEmbedding(row: UserMemory, expectedModel: string): number[] | null {
  if (row.embedding_model !== expectedModel) {
    return null;
  }
  const raw = parseJsonArray(row.embedding);
  if (raw === null || raw.length === 0) {
    return null;
  }
  const vector: number[] = [];
  for (const v of raw) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return null;
    }
    vector.push(v);
  }
  return vector;
}

/** JSON 列读回来可能是数组，也可能是字符串（某些驱动不自动解析）—— 两种都收 */
function parseJsonArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** 相关性排序的结果 */
export interface RankedMemories {
  /** 排好序的记忆（最相关的在前） */
  rows: UserMemory[];
  /** 记忆 id → 相关性得分 */
  scores: Map<string, number>;
}

/**
 * 按相关性排序：相关性降序 → 优先级兜底（来源 > 置信度 > 更新时间）。
 *
 * ⚠️ **没有向量的记忆按 0 分算**，不是排到最后 ——
 *    这样「缺向量」跟「有向量但不相关」是同一档，
 *    用户自己写的那条（优先级最高）不会被几条自动抽的记忆挤下去。
 */
export function rankByRelevance(
  rows: readonly UserMemory[],
  queryVector: readonly number[],
  expectedModel: string,
): RankedMemories {
  const scored = rows.map((row) => {
    const stored = readStoredEmbedding(row, expectedModel);
    const score = stored === null ? 0 : cosineSimilarity(stored, queryVector);
    return { row, score };
  });

  scored.sort((a, b) => {
    if (Math.abs(a.score - b.score) > 1e-9) {
      return b.score - a.score;
    }
    return compareMemoryPriority(a.row, b.row);
  });

  const scores = new Map<string, number>();
  for (const item of scored) {
    scores.set(item.row.id, item.score);
  }
  return { rows: scored.map((s) => s.row), scores };
}

// ============================================================
// 跟外部打交道：embedding
// ============================================================

/**
 * 当前平台的 embedding 模型名。
 *
 * 返回 null = 平台没配 embedding（provider 不提供 / .env 没写全）→
 * 相关性排序整个关掉，记忆退回固定顺序。
 */
export function currentEmbeddingModel(): string | null {
  try {
    return resolveEmbedding().embedModel;
  } catch {
    return null;
  }
}

/**
 * 带超时的批量向量化。超了就返回 null（**不抛**）。
 *
 * ⚠️ **为什么必须超时**：`embedBatch` 自己的超时是 60 秒 ——
 *    那是给「批量向量化一批文档块」准备的（量大、慢一点没关系）。
 *    但记忆这边有两种调用在**用户请求的关键路径上**：
 *    写入记忆（用户点「保存」）和每轮注入前的排序。
 *    embedding 服务挂着的时候，不能让用户的请求一起挂 60 秒。
 */
export async function embedTextsWithTimeout(
  texts: readonly string[],
  timeoutMs: number,
): Promise<number[][] | null> {
  if (texts.length === 0) {
    return [];
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      embedBatch([...texts]),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`embedding 超过 ${timeoutMs}ms 未返回`)),
          timeoutMs,
        );
      }),
    ]);
    return result;
  } catch (err: unknown) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      '计算向量失败（相关排序退回固定顺序，记忆照样能注入）',
    );
    return null;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * 给一个问题算向量（带超时）。
 *
 * ⚠️ **超时就当没有**：embedding 服务挂着不能把用户的对话一起挂住 ——
 *    拿不到向量就退回固定顺序排序，功能少一半但对话照常。
 */
export async function embedQueryVector(
  text: string,
  timeoutMs: number,
): Promise<number[] | null> {
  const result = await embedTextsWithTimeout([text], timeoutMs);
  const vector = result?.[0];
  return vector === undefined ? null : vector;
}

/**
 * 给缺向量 / 过期向量的记忆补算并写回。
 *
 * 一次调用把要补的正文**批量**送进 embedding（embedBatch 内部按 16 条一批），
 * 不是一条一次调用 —— 自动抽取一轮可能新增好几条记忆，逐条调用太浪费。
 *
 * @param timeoutMs 传了就带超时（用在用户请求的关键路径上）；不传 = 等 embedBatch 自己的 60 秒
 * @returns 写回了几条
 */
export async function backfillMemoryEmbeddings(
  rows: readonly UserMemory[],
  model: string,
  timeoutMs?: number,
): Promise<number> {
  if (embeddingSupport === 'missing') {
    return 0;
  }
  const targets = rows.filter((row) => readStoredEmbedding(row, model) === null);
  if (targets.length === 0) {
    return 0;
  }

  const contents = targets.map((row) => row.content);
  const vectors =
    timeoutMs === undefined
      ? await embedBatch(contents).catch((err: unknown) => {
          lastBackfillFailureAt = Date.now();
          throw err;
        })
      : await embedTextsWithTimeout(contents, timeoutMs);
  if (vectors === null) {
    lastBackfillFailureAt = Date.now();
    return 0;
  }

  let written = 0;
  for (const [index, row] of targets.entries()) {
    const vector = vectors[index];
    if (vector === undefined) {
      continue;
    }
    const { embedding, embedding_model } = serializeEmbedding(vector, model);
    row.embedding = embedding;
    row.embedding_model = embedding_model;
    try {
      // ⚠️ **只写这两列，且不动 updated_at** ——
      //    补向量不是「内容被改过」，后台列表里的「更新时间」应该只反映真实的编辑
      await row.save({ fields: ['embedding', 'embedding_model'], silent: true });
      written += 1;
    } catch (err: unknown) {
      if (isMissingColumnError(err)) {
        degradeMissingColumns(err instanceof Error ? err.message : String(err));
        return written;
      }
      logger.debug(
        { memoryId: row.id, err: err instanceof Error ? err.message : String(err) },
        '写入记忆向量失败（不影响记忆本身）',
      );
    }
  }
  return written;
}

/** 刚失败过就别再试了（省掉每轮重复的无效调用） */
export function shouldAttemptBackfill(): boolean {
  return Date.now() - lastBackfillFailureAt > BACKFILL_FAILURE_COOLDOWN_MS;
}

// ============================================================
// 降级：列不存在（迁移 035 没跑）
// ============================================================

/** 向量列现在能不能用（false = 迁移 035 没跑，已降级） */
export function isMemoryEmbeddingSupported(): boolean {
  return embeddingSupport !== 'missing';
}

/**
 * 降级：**把 embedding / embedding_model 两列从模型里摘掉**。
 *
 * ⚠️ **为什么必须摘列、而不是只改 WHERE**：
 *    Sequelize 的 SELECT 列清单来自**模型定义**，不是查询里写了什么。
 *    列不存在时，**任何**对 user_memories 的查询都会报
 *    `Unknown column 'embedding' in 'field list'` ——
 *    不只是召回这一条（记忆列表 / 计数 / 归档 全挂）。
 */
function degradeMissingColumns(reason: string): void {
  embeddingSupport = 'missing';
  for (const attribute of ['embedding', 'embedding_model']) {
    try {
      UserMemory.removeAttribute(attribute);
    } catch (err: unknown) {
      logger.debug(
        { attribute, err: err instanceof Error ? err.message : String(err) },
        '摘掉 UserMemory 的向量属性失败',
      );
    }
  }
  logger.warn(
    { reason },
    'user_memories.embedding 列不存在（迁移 035 没跑？），已降级为固定顺序的记忆排序',
  );
}

/**
 * 启动时探一次：`user_memories.embedding` 列在不在（迁移 035 跑了没）。
 *
 * ⚠️ **为什么在启动时探，而不是每个请求里 try/catch**：
 *    列不存在时每一次对 user_memories 的查询都会报错，
 *    与其让每个请求撞一次 500，不如启动时探一次、把列摘掉，**一次性解决所有路径**。
 *
 * @returns 列在 = true；不在 = false（已降级）
 */
export async function probeUserMemoryEmbeddingColumns(): Promise<boolean> {
  try {
    await UserMemory.findOne({ where: { embedding_model: '__probe__' }, attributes: ['id'] });
    embeddingSupport = 'available';
    return true;
  } catch (err: unknown) {
    if (!isMissingColumnError(err)) {
      // 探针失败（DB 抖了一下之类）≠ 列不存在 —— 不降级，留给请求路径自己撞一次
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        '探测 user_memories.embedding 列失败（不降级，按存在处理）',
      );
      return embeddingSupport !== 'missing';
    }
    degradeMissingColumns(err instanceof Error ? err.message : String(err));
    return false;
  }
}
