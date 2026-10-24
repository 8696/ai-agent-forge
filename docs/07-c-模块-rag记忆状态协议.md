# 07-c · 模块 · RAG、记忆、状态与 MCP（模块 08-12）

> **本文件是 `07-24模块知识点映射.md` 的模块 08-12**（原主文件已拆分为 07-a / 07-b / 07-c / 07-d / 07-e / 07-f 六份）。本份负责**RAG 基础 / RAG 进阶 / 记忆 / 状态工作流 / MCP**。
> LLM 基础与 Prompt 见 `07-a-模块-llm与prompt.md`；工具与 Agent 循环见 `07-b-模块-工具与agent.md`；框架与多代理见 `07-d-模块-框架与多代理.md`；评测 / 观测 / 可靠性见 `07-e-模块-评测观测可靠性.md`；安全与全栈见 `07-f-模块-安全与全栈.md`。

---

### 模块 08 · RAG 基础（向量检索）

**解决什么问题**：让 Agent 能基于真实产品文档、政策文档回答问题，而不是瞎编。

**用到的技术**：

- 文档分块（Chunking）：按段落 / 标题分，块大小 500-1000 字，重叠 100-200 字
- Embedding：把文本转成定长向量（维度随 provider 而定，见 `06` §6.1.2；1536 是 OpenAI 默认值）
- 向量检索（Vector Search）：余弦相似度（Cosine Similarity），Top-K
- 元数据过滤：按部门、时间、文档类型过滤（当前实现只强制按**租户**过滤，见下）

**选型理由**：Qdrant 是开源向量库，原生支持元数据过滤，比 Pinecone 便宜。

**当前实现**（`src/rag/`）：

| 文件           | 职责                                                                |
| -------------- | ------------------------------------------------------------------- |
| `chunk.ts`     | 800 字 / overlap 150 滑窗拆块，优先在段落 / 句子边界断开            |
| `embedding.ts` | OpenAI 兼容 REST，批量 16 条 / 批，429+5xx 退避重试，**维度强校验** |
| `qdrant.ts`    | 客户端 + `ensureCollection()` + `vectorSearch()`（`tenantId` 必填） |
| `ingest.ts`    | 同步 `ingestDocument()`：拆块 → 向量 → Qdrant → BM25                |

> **拆块为什么按字符数而不是 token 数**：中文 1 字 ≈ 1~2 token、英文 1 词 ≈ 1~2 token，
> 字符数对两者都够用且可预测。引入 tiktoken 会让「换 provider 要重算历史文档的块」变成常态问题。
> 真正影响精度的是「有没有在语义边界断开」和「overlap 够不够」，不是精确 token 计数。

> **维度强校验是必须的**：provider 实际返回的向量长度跟配置表不符时，
> `embedding.ts` 立刻抛错并提示「该删 Qdrant collection 重建」。
> 不校验的话错误会推迟到 Qdrant 写入时报一个很难懂的 dimension error。

---

### 模块 09 · RAG 进阶（混合检索 + 重排序）

**解决什么问题**：纯向量检索对「专有名词 / 型号 / 编号」类查询召回率差，需要结合关键词检索 + 重排序提升准确度。

**用到的技术**：

- 关键词检索（BM25）：处理专有名词、编号匹配
- 混合检索（Hybrid Search）：BM25 + 向量检索结果融合（Reciprocal Rank Fusion, RRF）
- 查询改写（Query Rewriting）：把口语化问题改成检索友好形态
- 重排序（Re-ranking）：用专门的重排序模型（如 bge-reranker）对 Top-K 重排

**选型理由**：bge-reranker-v2-m3 性价比高；RRF 是经典融合算法实现简单。

**当前实现**（`src/rag/bm25.ts` + `src/rag/hybrid-search.ts`）：

- **BM25**：`k1=1.5, b=0.75`；中文用 nodejieba 分词
  - 分词要点：先用正则把文本切成「连续中文」和「连续拉丁/数字」两类片段，
    只对中文片段过 jieba，英文片段整体当一个词。
    nodejieba 默认会把英文拆成单字母（`annual` → a/n/n/u/a/l），对 BM25 是灾难
  - IDF 用 `ln(1 + (N-df+0.5)/(df+0.5))` 的 +1 变体，保证高频词（的/是）不会拉低总分
  - **索引只存在内存里**，按租户分桶；启动时 `rebuildFromQdrant()` 从 Qdrant payload 重建（后台跑，不阻塞启动）
  - 局限：单进程、内存随语料线性增长、重启丢失（自愈）。
    语料再大一个量级要换成 Elasticsearch / OpenSearch 之类的持久化倒排；
    **多实例部署时各实例索引不共享，关键词召回会不一致**
  - nodejieba 自带词库有限（「年假」会切成「年」「假」）。查询和文档走同一套分词所以仍能对上，只是多字专名的精度打折
- **RRF 融合**：`k=60`，两路各取 `topK × 3` 候选再融合。
  同一 `doc_id + chunk_index` 会合并成一条（不是出现两次）
- **两路各自 try/catch**：向量库挂了就只剩关键词结果，关键词索引没重建就只剩向量结果 ——
  检索测试页是管理员排查索引质量的地方，任何一路挂掉都应该还能看到另一半
- ⏳ **查询改写 / 重排序尚未实现**：RRF 只用排名不用分数，对语义相关性的判别力有限，
  语料质量上来后需要 bge-reranker 之类的重排模型才能再提一档

---

### 模块 10 · 记忆（Memory）

**解决什么问题**：让 Agent 记住用户的短期对话历史 + 长期偏好。

**用到的技术**：

- 短期记忆（Short-term Memory）：当前会话的对话历史，直接查 `messages` 表
- 长期记忆（Long-term Memory）：用户偏好、历史问题模式，存 MySQL（`user_memories` 表）
- 摘要压缩：长会话定期摘要
- 记忆检索：基于 embedding 召回相关历史片段

**当前实现**（B1 · 2026-10-21 短期 / B4 · 2026-10-24 长期）：

| 能力 | 状态 | 位置 |
| ---- | ---- | ---- |
| 短期记忆：消息落库，DB 是真理 | ✅ | `src/services/chat.ts`（`insertUserMessage` / `insertAssistantPlaceholder` / `finalizeAssistantMessage`） |
| 历史重建：从 DB 还原喂给模型 | ✅ | `loadHistoryRows` + `historyToCountable`（只收 user + complete 的 assistant） |
| 上下文超预算 → 截断 | ✅ | `src/lib/token-estimate.ts` 的 `fitHistoryToBudget`，UI 侧用 `data-truncated` 告知用户 |
| 摘要压缩（调 LLM 总结早期对话写 `sessions.summary`） | ✅ 2026-10-24 | `src/services/session-summary.ts`：边界标记（`metadata.summary_boundary`）+ 滚动重写 + 独立模型 scope（`usage_scope='summary'`）+ 独立 trace（`kind='summary'`）；详见 [12-b §B1.1](./12-b-需求-ai对话能力.md) |
| **长期记忆：存储（`user_memories` 表）** | ✅ | `src/models/UserMemory.ts` + 迁移 `017-create-user-memories.ts` |
| **长期记忆：自动抽取（信号预筛 + LLM 抽取）** | ✅ | `src/services/memory.ts` 的 `hasMemorySignal` / `parseMemoryActions` / `extractAndApplyMemories`；抽取提示词在 `src/prompts/memory.ts` |
| **长期记忆：抽取模型可独立配置** | ✅ | `tenant_models.usage_scope`（`chat` / `memory`）+ `resolveExtractionLlm`；回落链：抽取模型 → 对话模型 → 平台默认 |
| **长期记忆：抽取进 trace/span** | ✅ | 独立 trace（`kind='memory'` / `name='memory.extract'`）+ 三段 span（`llm.extract` / `cost.record` / `storage.apply`），见 `src/services/trace.ts` |
| **长期记忆：冲突合并（新增 / 改写 / 归档）** | ✅ | `applyMemoryActions` —— **只允许改 `source='auto'` 的行**（用户/管理员背书过的模型不许动） |
| **长期记忆：写入前的三道检查** | ✅ | `sanitizeMemoryContent` —— PII 脱敏 + 结构标记拒收（`##` / `[1]` / `来源：` / 换行）+ 敏感词 + 注入规则 |
| **长期记忆：注入提示词** | ✅ | `buildMemoryContext` + `renderMemoryBlock`；拼在 `buildPrompt` 的资料段**前面** |
| **长期记忆：用户自助（看 / 改 / 删 / 开关）** | ✅ | `src/gateway/customer/memory-routes.ts` + 前台 `/customer/memories`（含**物理删除**端点：合规场景要的是真删不是软删） |
| **长期记忆：租户后台（看每个用户的）** | ✅ | `src/gateway/admin/memory-routes.ts` + 后台 `/admin/memories` |
| 记忆检索（embedding 召回相关历史片段） | ⏳ | 未做 —— 现在是「按优先级取 top N」，没有按当前问题做相关性排序 |

> **为什么截断和摘要是两回事**：截断是「丢掉更早的对话」，用户会感知到 AI 忘事
> （所以必须用 `data-truncated` 明说「已省略更早的 N 轮」，不能悄悄丢）；
> 摘要是「把早期对话压成一段话再喂回去」，体验上无感。文档 12-b §B1 的原始验收
> 「构造 200 轮验证摘要压缩」指的是后者，**2026-10-24 已完成**。
>
> **现在是两层叠加**：先截断（超预算就丢更早的轮次），再摘要压缩
> （丢掉的轮次折成摘要写进 `sessions.summary`，下一轮注入）。
> 所以被丢掉的内容**不是真丢了** —— 下一轮它会以摘要的形式回来。
> 代价是摘要**滞后一轮**。
>
> **长期记忆为什么另起一张表**：`users.preferences`（JSON）能存零散偏好，
> 但撑不住「逐条列出 / 编辑 / 归档 / 记来源和置信度 / 注入时只取 top N」。
> 那列现在只存**记忆总开关**（`memory_enabled`），条目本体在 `user_memories` 表。
>
> **抽取提示词为什么是代码常量**（`src/prompts/memory.ts`）：
> 跟评测裁判提示词（`src/prompts/evaluation.ts`）同一个套路 ——
> 抽取口径是平台固定的，租户改了就会各写各的记忆，跨租户没法比。
>
> **抽取输出不走 `generateObject`**：智谱等 Anthropic 兼容网关对 tool-based schema
> 的支持参差不齐，统一走「文本输出 + 宽松解析」（`parseMemoryActions`）。
>
> **token 估算是粗估且故意高估**：项目不引 tiktoken（理由同 `chunk.ts`：换 provider
> 不该让历史预算的计算方式漂移），估多了只是多裁几轮历史，估少了会在 provider 侧炸 400。

---

### 模块 11 · Agent 状态与工作流（State / Workflow）

**解决什么问题**：有些任务跨多轮、需要状态跟踪（如改单：用户先说要改 → 系统查询 → 用户确认改 → 实际改）；有些敏感操作需要人工审批。

**用到的技术**：

- 任务状态机（State Machine）：明确的状态 + 转移条件
- 断点恢复：Agent 中途挂了能从上次的状态继续
- 人工审批节点（Human-in-the-Loop, HITL）：敏感操作暂停，等人确认

**关键代码**：

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

> **当前 scope**：MCP 设计稿已保留（数据结构 / 工具注册表 `tools` 表），但**实际接入的 MCP 服务延后到 Phase 2**。MVP 阶段不接外部业务系统。

---
