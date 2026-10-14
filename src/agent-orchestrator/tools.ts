import { tool } from 'ai';
import { z } from 'zod';
import { logger } from '../logger';

/**
 * Agent 工具定义 —— 详见 docs/15 §Step 6 + docs/16-b §B2
 *
 * Step 6 MVP 行为：
 *  - 把可用工具集中 export，方便 chat-routes / chat-stream-routes 在 streamText({ tools })
 *    里直接挂上（即使本期不真正调工具，Vercel AI SDK 的 tool() 已支持 OpenAI / Anthropic 协议）
 *  - knowledge_search 是 MVP 的占位实现：返回固定字符串
 *  - 真正接入 RAG：Step 7（多轮 + 历史 + hybridSearch 注入 user 消息前的 [检索结果] 块）
 *  - MCP 工具：Step 12+（不在 Step 6 引入 MCP SDK）
 *
 * 用法：
 *   const tools = buildTools();
 *   streamText({ model, system, messages, tools });
 */

const knowledgeSearchInputSchema = z.object({
  query: z.string().min(1).max(2000).describe('检索问句（用户的最新问题）'),
  top_k: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe('返回的命中片段上限，默认 5'),
});

export const knowledgeSearchTool = tool({
  description:
    '从租户的知识库检索相关文档片段。当用户问题涉及上传的文档、政策、规章、FAQ 时调用。返回的 text 字段就是知识库原文片段，可直接引用。',
  parameters: knowledgeSearchInputSchema,
  /**
   * Step 6 MVP stub：固定返回提示字符串，让模型知道「工具已就绪但实际未接入」
   * Step 7 会改成实际调用 hybridSearch()：把 hits.map(h => h.text) 拼回字符串返回
   */
  execute: async (raw: unknown) => {
    const input = knowledgeSearchInputSchema.parse(raw);
    logger.info({ query: input.query, topK: input.top_k ?? 5 }, 'knowledgeSearchTool (MVP stub)');
    return '工具尚未启用（Step 7 接 RAG）；当前回答基于系统提示词和模型自身知识。';
  },
});

/**
 * 当前可用工具集合 —— 加新工具时在这里挂上（Step 12 加 MCP 工具也是同一注册位）
 */
export function buildTools(): { knowledge_search: typeof knowledgeSearchTool } {
  return {
    knowledge_search: knowledgeSearchTool,
  };
}
