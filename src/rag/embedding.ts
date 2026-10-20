import { resolveEmbedding } from '../config';
import { logger } from '../logger';

/**
 * Embedding 客户端 —— 详见 docs/06-大模型与Embedding.md §6.1
 *
 * 设计要点：
 *  - Embedding 走 **OpenAI 兼容 REST**（POST {baseUrl}/embeddings），跟 LLM 的 Anthropic 协议完全独立
 *  - provider / model / 维度全部由 src/config.ts:resolveEmbedding() 决定，业务代码不感知具体哪家
 *  - 维度在这里做**强校验**：provider 返回的向量长度跟配置不一致时立刻抛错。
 *    这是 RAG 最常见的线上事故——切了 embedding model 但没重建 Qdrant collection，
 *    错到检索时才炸；在这里炸，错误信息直接告诉你「该 DELETE collection 重建」
 */

/** Embedding 请求失败（网络 / 4xx / 维度不符），上层据此把文档标成 failed */
export class EmbeddingError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

/** 单次请求最多送多少条。取 16 是各 provider 都稳的上限（智谱 embedding-3 本身就是 16） */
const BATCH_SIZE = 16;

/** 429 / 5xx 的重试次数（指数退避，总等待不超过 ~3s） */
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 500;

interface EmbeddingApiItem {
  embedding: number[];
  index: number;
}

interface EmbeddingApiResponse {
  data: EmbeddingApiItem[];
  model?: string;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

/**
 * 批量向量化。入参出参等长、顺序一致。
 *
 * @throws EmbeddingError API 报错、重试仍失败、或返回向量数与请求数不符
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }
  const cfg = resolveEmbedding();
  const vectors: number[][] = [];

  for (let offset = 0; offset < texts.length; offset += BATCH_SIZE) {
    const batch = texts.slice(offset, offset + BATCH_SIZE);
    vectors.push(...(await embedOneBatch(batch, cfg)));
  }

  if (vectors.length !== texts.length) {
    throw new EmbeddingError(
      `Embedding 返回 ${vectors.length} 条向量，请求了 ${texts.length} 条`,
    );
  }
  assertDimensions(vectors, cfg.embedModel, cfg.embedDimensions);

  logger.debug(
    {
      provider: cfg.provider,
      model: cfg.embedModel,
      count: texts.length,
      dims: cfg.embedDimensions,
    },
    'Embedding 完成',
  );
  return vectors;
}

/** 单条向量化，检索路径用（query 只需要一条） */
export async function embedOne(text: string): Promise<number[]> {
  const [vector] = await embedBatch([text]);
  if (vector === undefined) {
    throw new EmbeddingError('Embedding API 返回空向量');
  }
  return vector;
}

type EmbeddingProviderConfig = ReturnType<typeof resolveEmbedding>;

async function embedOneBatch(
  batch: string[],
  cfg: EmbeddingProviderConfig,
): Promise<number[][]> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    if (attempt > 0) {
      await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    }
    try {
      return await requestEmbeddings(batch, cfg);
    } catch (err: unknown) {
      // 4xx（除 429）是「请求本身有问题」，重试多少次都一样，直接抛
      lastError = err;
      const status = err instanceof EmbeddingError ? err.status : undefined;
      const retryable = status === undefined || status === 429 || status >= 500;
      if (!retryable) {
        throw err;
      }
      logger.warn(
        { attempt, status, err: err instanceof Error ? err.message : String(err) },
        'Embedding 请求失败，准备重试',
      );
    }
  }
  throw lastError;
}

async function requestEmbeddings(
  batch: string[],
  cfg: EmbeddingProviderConfig,
): Promise<number[][]> {
  let response: Response;
  try {
    response = await fetch(`${cfg.embedBaseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.embedApiKey}`,
      },
      body: JSON.stringify({ model: cfg.embedModel, input: batch }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err: unknown) {
    throw new EmbeddingError(
      `Embedding 请求网络错误：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new EmbeddingError(
      `Embedding API 返回 ${response.status}：${detail.slice(0, 300)}`,
      response.status,
    );
  }

  const json = (await response.json()) as EmbeddingApiResponse;
  if (!Array.isArray(json.data) || json.data.length !== batch.length) {
    throw new EmbeddingError(
      `Embedding API 返回 ${Array.isArray(json.data) ? json.data.length : '非数组'} 条数据，请求了 ${batch.length} 条`,
    );
  }

  // provider 不保证按请求顺序返回，必须按 index 排回来
  return [...json.data]
    .sort((a, b) => a.index - b.index)
    .map((item) => item.embedding);
}

/**
 * 维度校验 —— 挡住「换了 embedding model 但没重建 Qdrant collection」这类事故。
 *
 * 症状：provider 正常返回 1024 维，但配置表里写的是 2048（或反之）。
 * 不校验的话，Qdrant 会在 upsert 时报一个很难懂的 "Vector dimension error"。
 */
function assertDimensions(vectors: number[][], model: string, expected: number): void {
  const actual = vectors[0]?.length ?? 0;
  if (actual === expected) {
    return;
  }
  throw new EmbeddingError(
    `Embedding 维度不符：模型 ${model} 实际返回 ${actual} 维，配置期望 ${expected} 维。` +
      '换 embedding 模型 / provider 后必须重建 Qdrant collection（见 docs/06 §6.1.4）。',
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}