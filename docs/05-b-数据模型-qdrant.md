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

**Vector（1536 维 float32）**：

- 来自 Embedding API（OpenAI text-embedding-3-small 或 bge-m3）
- 维度固定 1536，跨租户一致

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

> **关键**：搜索时**强制加 `tenant_id` 过滤**，避免跨租户泄露。这条在 `src/rag/search.ts` 写死，不让上层绕过。

### 5.6.3 Collection 操作

```typescript
// 上传时（src/rag/ingest.ts）
for (let i = 0; i < chunks.length; i++) {
  await qdrant.upsert('documents', {
    points: [
      {
        id: `${docId}-${i}`,
        vector: embeddings[i],
        payload: {
          doc_id: docId,
          chunk_index: i,
          text: chunks[i].text,
          tenant_id: tenantId,
          source: title,
          updated_at: Date.now(),
        },
      },
    ],
  });
}

// 搜索时（src/rag/search.ts）
const results = await qdrant.search('documents', {
  vector: queryEmbedding,
  limit: topK,
  filter: {
    must: [
      { key: 'tenant_id', match: { value: tenantId } }, // ← 强制租户隔离
    ],
  },
});
```

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
    │
    ▼
[5] 写 Qdrant
    │  每个点：
    │    vector: [0.012, ..., 0.567]   (1536 维)
    │    payload: { doc_id, chunk_index, text, tenant_id, source }
    │
    ▼
[6] 更新 MySQL documents.status='ready' + chunk_count=42
    │
    ▼
[7] 用户在 P1 聊天问问题
    │
    ▼
[8] RAG 检索（src/rag/search.ts）
    │  query → embedding → Qdrant.search(filter: tenant_id)
    │  → top 5 命中的 payload.text
    │
    ▼
[9] 把命中片段塞进 LLM system prompt
    │
    ▼
[10] Vercel AI SDK streamText() → 流式返回答案 + 引用卡片
```
