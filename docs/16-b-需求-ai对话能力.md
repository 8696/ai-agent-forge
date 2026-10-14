# 16-b · 需求 · AI 对话能力（B 类需求）

> **本文件是 `16-需求技术对照表.md` 的 B 类需求**（原主文件已拆分为 16-a / 16-b / 16-c / 16-d / 16-e 五份）。本份负责**AI 对话能力**：多轮对话 + RAG 检索 + 记忆。
> 多租户基础见 `16-a-需求-多租户与登录.md`；管理员可配置见 `16-c-需求-管理员可配置.md`；运维稳定见 `16-d-需求-运维稳定.md`；业务接入与平台运营见 `16-e-需求-业务接入与平台运营.md`。

## B · AI 对话能力（核心）

### B1 · 多轮对话 + 上下文窗口管理

**需求**：用户连问 N 轮，AI 记得历史；超出 token 预算自动压缩。

**对应 Step**：Step 5 / Step 6

**使用技术**：

- @anthropic-ai/sdk（**通过 Vercel AI SDK 的 `@ai-sdk/anthropic` 间接调用**；高级场景如 `cache_control` 可直接用）
- Token 预算（`src/lib/token-budget.ts`：给 system / history / retrieval / tools 各分配）
- 摘要压缩（`src/lib/summarize.ts`：超长时调 LLM 总结早期对话）
- Prompt Caching（`@ai-sdk/anthropic` 透传 `cacheControl: { type: 'ephemeral' }`）
- MySQL `messages` 表（每条消息持久化，DB 是真理）

**实现位置**：

- Agent 循环：`src/agent-orchestrator/loop.ts`（模块 07）
- 流式循环：`src/agent-orchestrator/loop-stream.ts`（Step 5）
- Token 预算：`src/lib/token-budget.ts`
- 摘要：`src/lib/summarize.ts`
- 模型：`src/models/Message.ts`

**关键代码**：

```typescript
// 主对话循环
const response = await anthropic.messages.create({
  model: config.MODEL_NAME,
  max_tokens: 1024,
  system: [
    {
      type: 'text',
      text: systemPrompt,
      cache_control: { type: 'ephemeral' }, // 缓存 system prompt
    },
  ],
  messages: history.map((m) => ({
    role: m.role,
    content: m.content,
  })),
  tools,
});

// 超长时摘要压缩
if (estimateTokens(history) > BUDGET.history) {
  const summary = await summarize(anthropic, history.slice(0, -10));
  history = [summaryMessage(summary), ...history.slice(-10)];
}
```

**验收**：

- 连问 5 轮，AI 记得前几轮
- 故意构造超长对话（200 轮），验证摘要压缩生效
- 同一条 system prompt 重复发，看 Anthropic API 响应里 `cache_read_input_tokens` 命中

---

### B2 · RAG 检索

**需求**：AI 基于上传的文档回答，引用具体片段。

**对应 Step**：Step 4 / Step 5

**使用技术**：

- Qdrant（向量库，存 embedding）
- Embedding API（OpenAI `text-embedding-3-small` 或 bge-m3，**独立 REST 客户端，不走 Anthropic SDK**）
- 关键词检索（BM25，本地内存索引）
- 重排序（`bge-reranker-v2-m3`，独立 HTTP 服务或本地推理）
- RRF（Reciprocal Rank Fusion）融合向量检索 + BM25 结果
- 查询改写（可选，把口语化问题改写成检索友好形态）

**实现位置**：

- 向量检索：`src/rag/search.ts`（Qdrant 查询 + metadata 过滤）
- Embedding：`src/rag/embedding.ts`（独立 REST 客户端）
- 混合检索：`src/rag/hybrid-search.ts`
- 重排序：`src/rag/rerank.ts`
- 文档拆块：`src/rag/ingest.ts`（`splitByChunk`，size=800 / overlap=150）
- 文档索引主流程：`src/rag/index-document.ts`

**关键代码**：

```typescript
// src/rag/hybrid-search.ts
export async function hybridSearch(query: string, tenantId: string, topK = 10) {
  // 1. query 转向量
  const queryVec = await embedding.embed(query);

  // 2. 向量检索
  const vectorResults = await qdrant.search('documents', {
    vector: queryVec,
    limit: topK * 2,
    filter: { must: [{ key: 'tenant_id', match: { value: tenantId } }] },
  });

  // 3. BM25 检索（用 lunr.js 或自建）
  const bm25Results = await bm25.search(query, { tenantId, limit: topK * 2 });

  // 4. RRF 融合
  const fused = reciprocalRankFusion([vectorResults, bm25Results], { k: 60 });

  // 5. 重排序
  return await rerank(query, fused.slice(0, topK * 2), { model: 'bge-reranker-v2-m3', topK });
}
```

**验收**：

- 上传一个 .md 文档，内容里有「年假 5 天」这句话
- 问「年假几天」→ AI 回答里出现「5 天」+ 引用了文档片段
- 在管理后台问同样问题（用「检索测试」功能），能看到 top 5 命中的片段

---

### B4 · 短期 + 长期记忆

**需求**：多轮对话的上下文；用户偏好的长期记忆。

**对应 Step**：Step 6

**使用技术**：

- 短期记忆：**直接查 `messages` 表**（不经过 Redis，当前规模够用）
- 长期记忆：MySQL `users.preferences` JSON 字段

**实现位置**：

- 短期：`src/memory/short-term.ts`
- 长期：`src/memory/long-term.ts`
- 模型：`src/models/Message.ts` / `users.preferences`

**关键代码**：

```typescript
// src/memory/short-term.ts
export class ShortTermMemory {
  async getHistory(sessionId: string, limit = 50): Promise<Message[]> {
    return await Message.findAll({
      where: { session_id: sessionId },
      order: [['created_at', 'DESC']],
      limit,
    });
  }
}

// 长期偏好
export async function getUserPreferences(userId: string) {
  const user = await User.findByPk(userId);
  return user?.preferences ?? {};
}
```

**验收**：

- 前台用户问 5 轮 → 刷新页面后挂件还能继续
- 改 `users.preferences` JSON 里的 `style: 'concise'`，下次回答变短
