# 数据库 / RAG / 配置变更日志

> 按时间倒序记录会影响 schema / Qdrant collection / env 配置的变更。回看时按「这是哪天改的、为什么」找入口。

---

## 2026-10-14 · Step 4 适配远程 Qdrant + 智谱 embedding-3

### 背景
Step 4 初版用 `text-embedding-3-small` + 1536 维 hardcode 在文档里。dev 切到远程 Qdrant + 智谱 embedding-3 后，3 个 HIGH bug 一起暴露。

### 改动

#### 1. Embedding provider 适配
- **bug**：原 `EMBEDDING_DIMENSIONS=1536` hardcode，但智谱 embedding-3 默认返回 2048 维 → Qdrant upsert 400
- **改**：Qdrant collection 维度改为按 Embedding provider 实际输出；`src/config.ts:resolveEmbedding` 集中管理
- **影响**：dev 切 Embedding provider 时必须 **DELETE Qdrant collection** 重建

#### 2. Qdrant 1.x point ID 校验
- **bug**：原用 `id: \`${docId}-${idx}\`` 字符串，Qdrant 1.x 只接受 `unsigned integer` / `UUID`
- **改**：`id: randomUUID()`，关联走 `payload.doc_id`
- **影响**：之前 Qdrant 0.x 还能用任意字符串 ID；升级到 1.x 必踩

#### 3. ensureCollection self-bootstrap 失效
- **bug**：`if (exists)` 拿到 `collectionExists` 返回的 `{ exists: boolean }` 对象（truthy），永远为 true → collection 永远不创建
- **改**：`if (res.exists === true) return;`
- **影响**：冷启动时第一次 ingest 才暴露

### 文档同步
- `docs/05-b-数据模型-qdrant.md` §5.6.2：维度说明从「固定 1536」改成「按 provider」
- `docs/15-开发进度计划.md` §Step 4：交付物条目更新（koa-body / resolveEmbedding）
- `docs/07-大模型与Embedding.md`：（待 Step 4 验收后补全 §7.1 的 provider 矩阵）

### env 结构调整
- 旧：单 Embedding 配置（`EMBEDDING_BASE_URL` / `EMBEDDING_API_KEY` / `EMBEDDING_MODEL`）
- 新：per-provider（`*_BASE_URL` / `*_EMBEDDING_MODEL`），`LLM_PROVIDER` 一切切换
- sync 脚本（`scripts/sync-env.ts`）改：保留 dev override（不再用模板覆盖非 secret）