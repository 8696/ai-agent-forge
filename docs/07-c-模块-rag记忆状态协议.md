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
| `elements/`    | **元素层**（2026-10-27 新增）：按格式把文档解析成带类型的元素序列（Markdown 走 AST / PDF 按页 / TXT 按段） |
| `chunk.ts`     | **结构感知切块**：按标题分节 → 节内按元素聚合成块 → 块首拼标题路径面包屑；超大元素按类型切（表按行 + 重复表头 / 代码按行 / 段落按句） |
| `embedding.ts` | OpenAI 兼容 REST，批量 16 条 / 批，429+5xx 退避重试，**维度强校验** |
| `qdrant.ts`    | 客户端 + `ensureCollection()` + `vectorSearch()`（`tenantId` 必填） |
| `ingest.ts`    | 同步 `ingestDocument()`：拆块 → 向量 → Qdrant → BM25                |

> **拆块为什么按字符数而不是 token 数**：中文 1 字 ≈ 1~2 token、英文 1 词 ≈ 1~2 token，
> 字符数对两者都够用且可预测。引入 tiktoken 会让「换 provider 要重算历史文档的块」变成常态问题。
> 真正影响精度的是「有没有在语义边界断开」和「overlap 够不够」，不是精确 token 计数。

> **为什么要有「元素层」（2026-10-27 改版的由来）**：
> 旧版切块是「把文档拍平成一串字符 → 按 800 字滑窗 → 尽量切在段落/句子边界」。
> 问题不在切点选得不好，而在于**结构信息在进切块器之前就没了**：
> Markdown 里的 `#` 标题、`|` 表格、``` 代码块，PDF 里的标题和版面，
> 全被拍平成字符，切块器只看得见换行和句号 ——
> 于是「本来属于一块的东西被从中间劈开」（比如「第二节 退款条件」的标题留在上一块末尾，
> 它的正文在下一块）。
>
> 现在的做法是**先解析成带类型的元素序列，再切**：
> ① **Markdown 用 AST 不用正则** —— 正则认标题很脆（`#` 后必须有空格、
>    `##` 在代码块里不是标题、Setext 标题 `===` 形式正则根本认不出），
>    AST 是解析器认定的结构，不会错
> ② **PDF 保住页边界** —— 页是 PDF 仅剩的结构信号（章节、换页）；
>    ⚠️ pdf-parse v2 默认会在每页后面插 `-- 1 of 12 --` 的页码标记，
>    **必须显式传 `pageJoiner: ''` 关掉**，否则那串噪声会进向量、进引用卡片
> ③ **TXT / PDF 的标题靠启发式猜** —— 保守起见只认强模式
>    （`第一章` / `一、` / `（一）` / `1.2 `），猜错的代价只是多一层面包屑，不会丢内容；
>    ⚠️ **弱规则（独立成段 + 短）猜出来的标题要「连续降级」** ——
>    PDF 抽出来的文本里一组并列的短行（「微信支付」/「支付宝」/「银行卡」）
>    每一条都满足弱规则 → 每条各自成一节 → 每条各自成一个块 →
>    一篇文档碎成几十个只有一两行的块。判据：**一串短行是一组并列项，不是层级标题**
> ④ **块首拼「标题路径」面包屑**（如 `产品手册 > 退款政策`）——
>    一节被切成 5 块时，每块都知道自己在文档的哪个位置（检索和模型都受益）；
>    ⚠️ **每块还带「第 i/N 块」**（本节第几块 / 共几块，进 payload 不进文本）——
>    同一节的几块内容互相独立、面包屑一模一样，光看文本分不出先后
> ⑤ **重叠区按元素携带，不按字符截断** —— 旧版是把上一块的尾巴按字符截断，
>    下一块开头就是一个半句话；现在带的是**完整元素**或**句子对齐的尾巴**；
>    ⚠️ **表格现在带「表头 + 尾部行」**（2026-10-27 改）——
>    以前表格完全不带，等于「凡是以表格结尾的块，后面的块跟它零重叠」，
>    而表格后面紧跟的往往正是解释性正文（「上表说明了…」），恰恰最需要上下文；
>    带的是**上一块的整个尾部元素**（不是把碎表格切两半），元素边界天然对齐
> ⑥ **代码块保留围栏和语言标记，切成多片时每片都闭合**（2026-10-27 改）——
>    剥掉围栏之后一段 Python 和一段 JSON 在向量里长得一样；
>    裸按行切的话中间几片是**开着的围栏**（模型看到的是坏代码）。
>    代码**整体**带走（带得下才带）—— 半截代码 + 开着的围栏比不带更糟
>
> **人工编辑切片（2026-10-27 新增）** —— 切片的正文现在**有权威副本**（MySQL
> `document_chunks` 表），Qdrant 只是检索索引。改一块 → **重算该块向量**
> （一块文本 = 一个向量；没改的块复用旧向量）→ 同步 BM25 → 写副本 → 留审计。
> 重新索引时人工编辑按**源区间重叠度**搬回新块（搬不回来的报 `unmatched_edits`，
> 不静默丢弃）。详见 [04-c §5.13.1](../04-c-ui-后台管理页面.md) 与
> [05-a · 文档切片表](../05-a-数据模型-mysql.md)。

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
- **重排序（✅ 2026-10-25 落地）**：RRF 融合**之后**、截断 topK **之前**，用重排模型给候选重打分。
  RRF 只用排名不用分数（k=60 把差距压得很平），重排模型把问题跟每个候选逐条对读再打分，
  判别力强得多 —— 「召回没问题、排序不对」的标准解法
  - 客户端 `src/rag/rerank.ts`：Cohere 兼容的 `POST {RERANK_API_URL}`，
    body `{model, query, documents, top_n}`，响应 `{results:[{index, relevance_score}]}`。
    自建的 `bge-reranker-v2-m3`（起 Cohere 兼容服务）、硅基流动、Jina、Cohere 都吃这个格式
  - 编排 `hybrid-search.ts` 的 `rerankAndTrim`：融合 → 重排 → 截断 topK
  - **降级**：重排调不通（网络 / 超时 / 5xx / 格式不对）自动退回纯 RRF 顺序，检索不挂
  - 两层开关：平台 `.env` 的 `RERANK_ENABLED`（硬边界）+ 租户 `rerank_enabled`；
    **`RERANK_API_URL` 留空 = 不做重排**（配好地址即生效）
  - 已知边界（多一次调用 / 多一次成本 / 不计入 cost_logs / 只改排序不改召回）见
    [12-b §B2](./12-b-需求-ai对话能力.md) 的「已知限制 / 注意事项」
- ✅ **查询改写已实现**（2026-10-25，`src/rag/query-rewrite.ts`）：
  租户级开关 `query_rewrite_enabled`，**默认关闭** —— 每轮多一次模型调用（多 1~3 秒 + 一份花费），
  而短问题（「年假几天」）改写基本没收益；改写失败一律回落原查询，不影响检索

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
| 记忆检索（embedding 召回相关历史片段） | ✅ 2026-10-26 | `src/services/memory-relevance.ts`：向量存 `user_memories.embedding`（迁移 `035`）+ 余弦相似度排序 + 相关性是主序 / 优先级兜底；没有向量的按 0 分算（不饿死）；embedding 挂了 / 没配 / 迁移没跑 → 退回固定顺序。详见 12-b §B4 |

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

> **本项目已落地**（2026-10-26）：MySQL `missions` 表（迁移 `028`）+ 手写工作流引擎
> （`src/workflows/`）+ 闸门接入（`src/tools/execute.ts` 的 `runtime.gate`），
> 三条电商流程（退款 / 改地址 / 售后工单）的状态图见
> [12-b §B5.1](./12-b-需求-ai对话能力.md)。
> ⚠️ **本项目的状态机是「模型驱动」的** —— 推动流程前进的是模型调工具，
> 不是引擎自己往下走；断点恢复靠提示词把进度告诉模型。
> 这个语义跟 LangGraph 的「图驱动」不同，是选型时的关键差别。

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

> 🚫 **本项目不做 MCP**（用户 2026-10-26 拍板）。
>
> **理由**：MCP 是**跨系统**的 —— 每一套要接入的业务系统都得自己写一个 MCP server
> （用 `@modelcontextprotocol/sdk`）并跑起来，平台方这边也得先有服务方能连。
> 本项目的主旨是**「当前一个系统能做完」**，MCP 不在这个范围里。
>
> **对应的替代**：租户自己的 REST 接口用 `http` 类型的工具接，
> 但**是本地 mock**（保留 url/method 的配置形状，平台不真的发请求）——
> 见 [12-b §B3](./12-b-需求-ai对话能力.md) 与
> [12-e 需求裁定表](./12-e-需求-业务接入与平台运营.md) #1 / #2。
>
> `tools` 表的 `type` 枚举里**保留 `mcp` 这个值**（将来真有服务方了不用改表结构），
> 但端点层直接拒绝 —— 免得出现「注册了但永远调不通」的死条目。

---
