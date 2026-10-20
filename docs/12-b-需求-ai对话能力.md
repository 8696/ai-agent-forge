# 12-b · 需求 · AI 对话能力（B 类需求）

> **本文件是 `12-需求技术对照表.md` 的 B 类需求**（原主文件已拆分为 12-a / 12-b / 12-c / 12-d / 12-e 五份）。本份负责**AI 对话能力**：多轮对话 + RAG 检索 + 记忆。
> 多租户基础见 `12-a-需求-多租户与登录.md`；管理员可配置见 `12-c-需求-管理员可配置.md`；运维稳定见 `12-d-需求-运维稳定.md`；业务接入与平台运营见 `12-e-需求-业务接入与平台运营.md`。

> 这是一份「**需求 → 技术**」的对照表的 B 类（AI 对话能力：多轮对话 + RAG + 记忆）。每条需求列出：
>
> - **需求**（一句话描述）
> - **使用技术**（库名 / 协议 / 中间件，不带具体路径）
> - **验收**（验证条件）

## B · AI 对话能力（核心）

### B1 · 多轮对话 + 上下文窗口管理

**需求**：用户连问 N 轮，AI 记得历史；超出 token 预算自动压缩。

**使用技术**：

- @anthropic-ai/sdk（**通过 Vercel AI SDK 的 `@ai-sdk/anthropic` 间接调用**；高级场景如 `cache_control` 可直接用）
- Token 预算（给 system / history / retrieval / tools 各分配）
- 摘要压缩（超长时调 LLM 总结早期对话）
- Prompt Caching（`@ai-sdk/anthropic` 透传 `cacheControl: { type: 'ephemeral' }`）
- MySQL `messages` 表（每条消息持久化，DB 是真理）

**验收**：

- 连问 5 轮，AI 记得前几轮
- 故意构造超长对话（200 轮），验证摘要压缩生效
- 同一条 system prompt 重复发，看 Anthropic API 响应里 `cache_read_input_tokens` 命中

---

### B2 · RAG 检索 ⚠️ 检索层已完成，对话层未接

**需求**：AI 基于上传的文档回答，引用具体片段。

**当前状态（2026-10-20）**：**检索层已完整落地**（向量 + BM25 + RRF），
可由 `/admin/knowledge/test` 检索测试页独立验证。
但**聊天对话接口本身还没实现**（chat 路由、sessions / messages 表都不在当前代码里），
所以「AI 基于检索结果作答 + 引用片段」这半段要等 B1 落地后才能端到端跑通。

**使用技术**：

- Qdrant（向量库，存 embedding）—— ✅ 已实现
- Embedding API（OpenAI 兼容 REST，**独立客户端，不走 Anthropic SDK**；
  实际走哪个模型由 `.env` 的 `LLM_PROVIDER` 决定，dev 用智谱 embedding-3）—— ✅ 已实现
- 关键词检索（BM25，进程内内存索引，启动时从 Qdrant 重建）—— ✅ 已实现
- RRF（Reciprocal Rank Fusion，k=60）融合向量 + BM25 结果 —— ✅ 已实现
- 重排序（`bge-reranker-v2-m3`）—— ⏳ 未实现，RRF 只用排名不用分数，语义判别力有限
- 查询改写（可选，把口语化问题改写成检索友好形态）—— ⏳ 未实现

**验收**：

- ✅ 上传一个 .md 文档，内容里有「年假 5 天」这句话
- ⏳ 问「年假几天」→ AI 回答里出现「5 天」+ 引用了文档片段（依赖 B1 聊天接口）
- ✅ 在管理后台问同样问题（用「检索测试」功能），能看到 top N 命中的片段，
  每条标出「语义第 N / 关键词第 N」

---

### B4 · 短期 + 长期记忆

**需求**：多轮对话的上下文；用户偏好的长期记忆。

**使用技术**：

- 短期记忆：MySQL `messages` 表
- 长期记忆：MySQL `users.preferences` JSON 字段

**验收**：

- 前台用户问 5 轮 → 刷新页面后挂件还能继续
- 改 `users.preferences` JSON 里的 `style: 'concise'`，下次回答变短