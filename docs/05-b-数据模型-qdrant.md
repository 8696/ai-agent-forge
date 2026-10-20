# 05-b · 数据模型 · Qdrant 向量库

> **本文件是 `05-数据模型.md` 的 §5.6 节**（原主文件已拆分为 05-a / 05-b 两份）。本份负责**向量库 Qdrant** 的 Collection 设计 + 操作 + 跟 MySQL 的关联 + 完整 RAG 数据流。
> MySQL 12 张核心表见 `05-a-数据模型-mysql.md`。

---

## 5.6 向量库 Qdrant（不进 MySQL 的那部分）

> **整个系统的数据 = MySQL（结构化）+ Qdrant（向量）两部分**。
> 这节专门说 Qdrant 那边存什么、怎么存、怎么跟 MySQL 对上。

### 5.6.1 为什么向量不存 MySQL

| 维度        | MySQL                  | Qdrant                         |
| ----------- | ---------------------- | ------------------------------ |
| 数据类型    | 文本 / 数字 / JSON     | 浮点数向量（1536 维）+ payload |
| 索引        | B+ 树                  | HNSW（近似最近邻 ANN）         |
| 检索 1 万条 | 全表扫描 → 秒级        | 向量索引 → 毫秒级              |
| 适合        | 事务 / JOIN / 精确过滤 | 相似度搜索 / 语义检索          |

> 1 个 1536 维 float 向量 ≈ 6 KB；1 万块 = 60 MB。MySQL 存这些字段 + 跑相似度查询 ≈ 性能灾难。Qdrant 专门干这个。

### 5.6.2 Collection 设计

```
Collection: documents          (租户共享一个 collection)
每条记录（vector + payload）= 一个文档块
```

**Vector（维度按 Embedding provider 实际输出）**：

- 来自 Embedding API（OpenAI / 智谱 / 千问 / MiniMax 等 OpenAI 兼容 provider）
- 维度按 provider / model 而定，**与 `src/config.ts:resolveEmbedding().dimensions` 一致**：
  - OpenAI text-embedding-3-small：1536
  - 智谱 embedding-3：2048（默认；支持 1024 / 768 / 512）
  - 千问 text-embedding-v3：1024
  - MiniMax embo-01：1024
- 改 Embedding provider 或 model 时必须 **删 Qdrant collection 重建**（collection 维度在创建时定死）

**Payload（JSON 元数据）**：

| 字段          | 类型            | 说明                         |
| ------------- | --------------- | ---------------------------- |
| `doc_id`      | string          | 关联 MySQL `documents.id`    |
| `chunk_index` | int             | 块在文档中的位置（0-based）  |
| `text`        | string          | 块的原文（给 LLM 做引用）    |
| `tenant_id`   | string          | 租户隔离（搜索时强制过滤）   |
| `source`      | string          | 文档标题（UI 显示用）        |
| `department`  | string?         | 可选：部门（未来按部门过滤） |
| `updated_at`  | int (timestamp) | 文档更新时间                 |

> **关键**：搜索时**强制加 `tenant_id` 过滤**，避免跨租户泄露。这条写死在 `src/rag/qdrant.ts:vectorSearch()` 里，
> 且该函数的 `tenantId` 参数**没有默认值**——调用方拿不到租户 id 就编译不过，从根上杜绝「忘了加 filter」。
> MySQL 侧同样强制：所有 `documents` 查询都带 `where: { tenant_id }`，跨租户访问一律按「不存在」处理（404 而不是 403）。

### 5.6.3 Collection 操作

> 代码：`src/rag/qdrant.ts`（客户端 v1.19，用的是新的 `query({ query: { nearest } })` API，不是老的 `search()`）

| 操作               | 函数                     | 说明                                                                      |
| ------------------ | ------------------------ | ------------------------------------------------------------------------- |
| 自举建 collection  | `ensureCollection()`     | 不存在才建；并发创建时吞掉「already exists」——collection 存在本身就是目标 |
| 写一个文档的全部块 | `upsertDocumentChunks()` | **先按 doc_id 删旧点再写**，重试索引不会留下新旧混杂                      |
| 删某文档全部块     | `deleteDocumentPoints()` | 删文档 / 重试索引前调用                                                   |
| 向量召回           | `vectorSearch()`         | `tenantId` 必填，filter 内部拼死                                          |
| 全量滚出 payload   | `scrollAllChunks()`      | 分页拉，只取 payload 不取向量；BM25 重建用                                |
| 总点数             | `countPoints()`          | 文档管理页「向量库总点数」统计卡                                          |

- `tenant_id` / `doc_id` 上都建了 **keyword payload index**：没有它，带过滤的检索在数据量大后会退化成全扫
- point id 用 `randomUUID()`（Qdrant 1.x 只接受 UUID / 无符号整数）；跟 `documents.id` 的关联走 `payload.doc_id`
- 写入按 64 条一批切分：Qdrant 单请求体有上限，几百块的文档一次性发会被拒
- `updated_at` 存的是**毫秒时间戳**（`Date.now()`），不是 ISO 字符串

### 5.6.4 跟 MySQL 的关联

| Qdrant 字段             | 关联到 MySQL                                        |
| ----------------------- | --------------------------------------------------- |
| `payload.doc_id`        | `documents.id`                                      |
| `payload.tenant_id`     | `tenants.id`（也写进 `documents.tenant_id` 做冗余） |
| `documents.chunk_count` | Qdrant 里这个文档对应的点数量                       |
| `documents.status`      | `uploaded` / `indexing` / `ready` / `failed`        |

**没有 Qdrant 的数据**：MySQL 不直接存向量；只有元数据（doc_id、status、chunk_count）。
**没有 MySQL 的数据**：Qdrant 不存租户名、用户信息、文档标题的详细元数据；只存搜索需要的 payload。

### 5.6.5 备份与迁移

- **Qdrant 数据备份**：`curl -X POST http://localhost:6333/collections/documents/snapshots`（导出快照文件）
- **Qdrant 数据迁移**：快照文件可恢复到另一个 Qdrant 实例
- **跟 MySQL 一起备份**：快照存 `./data/qdrant-snapshot/`，跟 `./backups/mysql-*.sql` 一起管理

### 5.6.6 完整的 RAG 数据流（PDF 上传 → 检索回答）

```
[1] 用户上传 PDF
    │
    ▼
[2] 后端 Koa 接收文件
    │
    ├─→ 写本地 ./data/uploads/{tenant_id}/{nanoid}.pdf
    ├─→ 写 MySQL documents 表（status='indexing'）
    │
    ▼
[3] 拆块：PDF → text → splitByChunk (800字/块, overlap=150)
    │
    ▼
[4] Embedding API → 每个块得到 1536 维向量
    │  （src/rag/embedding.ts：批量 16 条 / 批，429+5xx 退避重试 2 次）
    │  维度强校验：provider 实际返回的维度和配置表不符 → 立刻抛错，
    │  错误信息直接告诉你「该删 collection 重建」，而不是等 Qdrant 报天书
    │
    ▼
[5] 写 Qdrant
    │  每个点：
    │    vector: [0.012, ..., 0.567]   (维度按当前 provider)
    │    payload: { doc_id, chunk_index, text, tenant_id, source, updated_at }
    │
    ▼
[5b] 写 BM25 进程内索引（src/rag/bm25.ts）
    │  挂了只降级为「关键词这一路没有结果」，不抛错、不影响向量检索
    │
    ▼
[6] 更新 MySQL documents.status='ready' + chunk_count=42
    │  失败则 status='failed' + error_message 写错误摘要（HTTP 仍返 200，
    │  管理员能在列表里看到这条并点「重新索引」，比抛 5xx 丢掉记录好）
    │
    ▼
[7] 用户提问（检索测试页 /admin/knowledge/test）
    │
    ▼
[8] RAG 检索（src/rag/hybrid-search.ts）
    │  ├─ 向量路：query → embedding → Qdrant 召回
    │  ├─ 关键词路：query → nodejieba 分词 → BM25 召回
    │  └─ RRF 融合（k=60，每路取 topK×3 候选）→ topK
    │
    ▼
[9] 把命中片段塞进 LLM system prompt
    │
    ▼
[10] Vercel AI SDK streamText() → 流式返回答案 + 引用卡片
```

> **同步 vs 异步**：当前 [1]~[6] 全在上传的 HTTP 请求里同步跑完。
> 好处是前端不用轮询状态、实现简单；代价是大 PDF 会占住连接（Koa 自身不超时，但前置网关会）。
> 将来要改异步时，把 `ingestDocument()` 包成队列任务即可，路由和前端不用动。
>
> **重新索引**：`POST /api/v1/admin/knowledge/:id/reindex` 复用磁盘上的原文件（`documents.file_path`）
> 重跑整条链路。`upsertDocumentChunks()` 和 `bm25Add()` 都以「先按 doc_id 删」开头，
> 所以重试永远从干净状态开始，不会累积残块。
>
> **BM25 索引重建**：BM25 索引只活在内存里，进程重启即丢。
> `server.ts` 启动时后台调 `rebuildFromQdrant()`，从 Qdrant 的 payload 把每个 chunk 的原文拉回来重建
> （Qdrant 里存了 `payload.text`）。**不 await**：Qdrant 不可用或数据量大时都不拖住启动，
> 重建期间检索只有向量一路结果，完成后自动变混合检索。
