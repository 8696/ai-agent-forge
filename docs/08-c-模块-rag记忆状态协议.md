# 08-c · 模块 · RAG、记忆、状态与 MCP（模块 08-12）

> **本文件是 `08-24模块知识点映射.md` 的模块 08-12**（原主文件已拆分为 08-a / 08-b / 08-c / 08-d / 08-e / 08-f 六份）。本份负责**RAG 基础 / RAG 进阶 / 记忆 / 状态工作流 / MCP**。
> LLM 基础与 Prompt 见 `08-a-模块-llm与prompt.md`；工具与 Agent 循环见 `08-b-模块-工具与agent.md`；框架与多代理见 `08-d-模块-框架与多代理.md`；评测 / 观测 / 可靠性见 `08-e-模块-评测观测可靠性.md`；安全与全栈见 `08-f-模块-安全与全栈.md`。

---

### 模块 08 · RAG 基础（向量检索）

**解决什么问题**：让 Agent 能基于真实产品文档、政策文档回答问题，而不是瞎编。

**用到的技术**：

- 文档分块（Chunking）：按段落 / 标题分，块大小 500-1000 字，重叠 100-200 字
- Embedding：把文本转成 1536 维向量
- 向量检索（Vector Search）：余弦相似度（Cosine Similarity），Top-K
- 元数据过滤：按部门、时间、文档类型过滤

**关键代码**：

```typescript
// src/rag/ingest.ts
export async function ingestDocument(doc: Document) {
  const chunks = splitByChunk(doc.content, {
    chunkSize: 800,
    overlap: 150,
    splitter: 'recursive', // 优先按段落、句子切
  });

  const embeddings = await embedding.embedBatch(chunks.map((c) => c.text));

  await qdrant.upsert('documents', {
    points: chunks.map((chunk, i) => ({
      id: `${doc.id}-${i}`,
      vector: embeddings[i],
      payload: {
        doc_id: doc.id,
        text: chunk.text,
        chunk_index: i,
        source: doc.source,
        department: doc.department,
        updated_at: doc.updated_at,
      },
    })),
  });
}

// src/rag/search.ts
export async function search(query: string, topK: number = 5) {
  const queryEmbedding = await embedding.embed(query);
  const results = await qdrant.search('documents', {
    vector: queryEmbedding,
    limit: topK,
    score_threshold: 0.7,
    filter: {
      must: [{ key: 'department', match: { value: userDepartment } }],
    },
  });
  return results;
}
```

**选型理由**：Qdrant 是开源向量库，原生支持元数据过滤，比 Pinecone 便宜。

---

### 模块 09 · RAG 进阶（混合检索 + 重排序）

**解决什么问题**：纯向量检索对「专有名词 / 型号 / 编号」类查询召回率差，需要结合关键词检索 + 重排序提升准确度。

**用到的技术**：

- 关键词检索（BM25）：处理专有名词、编号匹配
- 混合检索（Hybrid Search）：BM25 + 向量检索结果融合（Reciprocal Rank Fusion, RRF）
- 查询改写（Query Rewriting）：把口语化问题改成检索友好形态
- 重排序（Re-ranking）：用专门的重排序模型（如 bge-reranker）对 Top-K 重排

**关键代码**：

```typescript
// src/rag/hybrid-search.ts
export async function hybridSearch(query: string, topK: number = 10) {
  // 1. 查询改写：补全上下文、去口语化
  const rewritten = await rewriteQuery(query);

  // 2. 并行跑 BM25 + 向量检索
  const [bm25Results, vectorResults] = await Promise.all([
    bm25.search(rewritten, { limit: topK * 2 }),
    qdrant.search('documents', {
      vector: await embedding.embed(rewritten),
      limit: topK * 2,
    }),
  ]);

  // 3. RRF 融合
  const fused = reciprocalRankFusion([bm25Results, vectorResults], { k: 60 });

  // 4. 重排序
  const reranked = await rerank(query, fused.slice(0, topK * 2), {
    topK,
    model: 'bge-reranker-v2-m3',
  });

  return reranked;
}
```

**选型理由**：bge-reranker-v2-m3 性价比高；RRF 是经典融合算法实现简单。

---

### 模块 10 · 记忆（Memory）

**解决什么问题**：让 Agent 记住用户的短期对话历史 + 长期偏好。

**用到的技术**：

- 短期记忆（Short-term Memory）：当前会话的对话历史，直接查 `messages` 表
- 长期记忆（Long-term Memory）：用户偏好、历史问题模式，存 MySQL
- 摘要压缩：长会话定期摘要
- 记忆检索：基于 embedding 召回相关历史片段

**关键代码**：

```typescript
// src/memory/short-term.ts
import { Op } from 'sequelize';
import { Message } from '@/models/Message';

// 直接查 messages 表（不经过 Redis；当前规模每次请求多一次 SELECT 完全够用）
export class ShortTermMemory {
  async getHistory(sessionId: string, limit = 50): Promise<Message[]> {
    return await Message.findAll({
      where: { session_id: sessionId },
      order: [['created_at', 'DESC']],
      limit,
    });
  }

  async append(sessionId: string, message: Message) {
    // 写入 messages 表（DB 是真理）
    await Message.create(message);
  }
}

// src/memory/long-term.ts
export class LongTermMemory {
  async getUserPreferences(userId: string) {
    return await db.userPreferences.findUnique({ where: { userId } });
  }

  async updatePreferences(userId: string, signal: UserSignal) {
    // 从对话里提取偏好信号（如"我喜欢简短回答"）
    // 写入数据库
  }
}
```

---

### 模块 11 · Agent 状态与工作流（State / Workflow）

**解决什么问题**：有些任务跨多轮、需要状态跟踪（如改单：用户先说要改 → 系统查询 → 用户确认改 → 实际改）；有些敏感操作需要人工审批。

**用到的技术**：

- 任务状态机（State Machine）：明确的状态 + 转移条件
- 断点恢复：Agent 中途挂了能从上次的状态继续
- 人工审批节点（Human-in-the-Loop, HITL）：敏感操作暂停，等人确认

**关键代码**：

```typescript
// src/workflow/state-machine.ts
type TaskState =
  | 'pending'
  | 'researching'
  | 'awaiting_confirmation'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'cancelled';

interface TaskTransition {
  from: TaskState;
  to: TaskState;
  trigger: string;
  guard?: (ctx: TaskContext) => boolean;
}

export const taskStateMachine: TaskTransition[] = [
  { from: 'pending', to: 'researching', trigger: 'start' },
  {
    from: 'researching',
    to: 'awaiting_confirmation',
    trigger: 'research_done',
    guard: (ctx) => ctx.is_sensitive,
  },
  {
    from: 'researching',
    to: 'executing',
    trigger: 'research_done',
    guard: (ctx) => !ctx.is_sensitive,
  },
  { from: 'awaiting_confirmation', to: 'executing', trigger: 'user_confirm' },
  { from: 'awaiting_confirmation', to: 'cancelled', trigger: 'user_cancel' },
  { from: 'executing', to: 'completed', trigger: 'success' },
  { from: 'executing', to: 'failed', trigger: 'error' },
];
```

---

### 模块 12 · 模型上下文协议（MCP）

**解决什么问题**：让 Agent 接入外部业务系统（订单系统、工单系统）有标准协议。

**用到的技术**：

- MCP 客户端（Client SDK）
- 工具定义（Tool Definition）：name、description、input schema
- 工具调用（Tool Invocation）
- 资源（Resources）：文件型数据
- 提示（Prompts）：预设模板

**怎么用**：

- 接入每个业务系统时，写一个 MCP 服务器（用 `@modelcontextprotocol/sdk`）
- Agent 通过 MCP 客户端连接，按统一协议发现工具、调用工具
- 避免每个业务系统都写一遍工具适配

> **当前 scope**：MCP 设计稿已保留（数据结构 / 工具注册表 `tools` 表），但**实际接入的 MCP 服务延后到 Phase 2**。MVP 阶段不接外部业务系统。模块 12 关键代码 + 端到端实现详见 `13-e-后端代码-mcp服务.md`。

---
