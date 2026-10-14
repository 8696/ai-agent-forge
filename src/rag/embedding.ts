import { resolveEmbedding } from '../config';
import { logger } from '../logger';

/**
 * Embedding 客户端（独立 REST，OpenAI 兼容协议）—— 详见 docs/07 §7.1
 *
 * 设计要点：
 *  - LLM 走 Anthropic 协议（Vercel AI SDK），Embedding 走 OpenAI 兼容 REST（独立）
 *  - 配置由 LLM_PROVIDER 一键切：src/config.ts:resolveEmbedding() 集中返回
 *  - 维度由 provider 决定，调用方不用管
 *  - 失败抛 EmbeddingError，让上层 ingestDocument 标 `failed`
 */

export class EmbeddingError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

interface EmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage?: { prompt_tokens: number; total_tokens: number };
}

/**
 * 批量 embedding —— 把字符串数组一次性发给 API，省得 N 次 HTTP。
 * 单批 ≤ 32 条（保守一些，少触发 provider 限流）。
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const cfg = resolveEmbedding();
  const out: number[][] = [];
  const BATCH = 32;
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH);
    const resp = await fetch(`${cfg.embedBaseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.embedApiKey}`,
      },
      body: JSON.stringify({
        model: cfg.embedModel,
        input: slice,
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new EmbeddingError(
        `Embedding API 失败 ${resp.status}: ${body.slice(0, 200)}`,
        resp.status,
      );
    }
    const json = (await resp.json()) as EmbeddingResponse;
    // 按 index 排序回来（provider 不一定按请求顺序返回）
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    for (const d of sorted) {
      out.push(d.embedding);
    }
  }
  logger.debug(
    { provider: cfg.provider, model: cfg.embedModel, count: texts.length, dims: cfg.embedDimensions },
    'Embedding 完成',
  );
  return out;
}

/** 调 1 个文本的便捷包装（检索测试用） */
export async function embedOne(text: string): Promise<number[]> {
  const [v] = await embedBatch([text]);
  if (v === undefined) {
    throw new EmbeddingError('Embedding API 返回空向量');
  }
  return v;
}
