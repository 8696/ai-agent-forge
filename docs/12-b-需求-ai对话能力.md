# 12-b · 需求 · AI 对话能力（B 类需求）

> **本文件是 `12-需求技术对照表.md` 的 B 类需求**（原主文件已拆分为 12-a / 12-b / 12-c / 12-d / 12-e 五份）。本份负责**AI 对话能力**：多轮对话 + RAG 检索 + 记忆。
> 多租户基础见 `12-a-需求-多租户与登录.md`；管理员可配置见 `12-c-需求-管理员可配置.md`；运维稳定见 `12-d-需求-运维稳定.md`；业务接入与平台运营见 `12-e-需求-业务接入与平台运营.md`。

> 这是一份「**需求 → 技术**」的对照表的 B 类（AI 对话能力：多轮对话 + RAG + 记忆）。每条需求列出：
>
> - **需求**（一句话描述）
> - **使用技术**（库名 / 协议 / 中间件，不带具体路径）
> - **验收**（验证条件）

## B · AI 对话能力（核心）

### B1 · 多轮对话 + 上下文窗口管理 ✅ 已落地（2026-10-21）

**需求**：用户连问 N 轮，AI 记得历史；超出 token 预算自动压缩。

**使用技术**：

- Vercel AI SDK v7：`streamText()` + `createUIMessageStream()` + `pipeUIMessageStreamToResponse()`
  （`@ai-sdk/anthropic` v4 的 `createAnthropic({apiKey, baseURL})` 走 provider 切换）
- 前端 `@ai-sdk/react` v4 的 `useChat()` + `DefaultChatTransport`，
  **1 行接 SSE**、自动重连、abort 取消、token 计数
- 自定义 `data-*` part 传引用片段（不是自定义 SSE —— AI SDK 的 chunk 协议原生支持）
- Token 预算（system / 历史 / 检索三块分配）+ 预算截断（`src/lib/token-estimate.ts`）
- MySQL `sessions` / `messages` 表（建表迁移 `src/migrations/009-create-sessions-messages.ts`）
- `tenant_id` 永远从 JWT 取，历史一律从 DB 重建，**不信任客户端发来的 messages**

**接口**（`src/gateway/customer/chat-routes.ts`，前缀 `/api/v1/customer`，要求 customer 角色）：

| 方法   | 路径                        | 说明                                                |
| ------ | --------------------------- | --------------------------------------------------- |
| GET    | `/sessions`                 | 会话列表（分页 + 标题 + 消息数 + 最后消息时间）      |
| POST   | `/sessions`                 | 新建会话（channel = `web`）                          |
| GET    | `/sessions/:id`             | 会话详情                                             |
| PATCH  | `/sessions/:id`             | 重命名                                               |
| DELETE | `/sessions/:id`             | 删会话（messages 由 DB 级联删）                      |
| GET    | `/sessions/:id/messages`    | 历史消息（`useChat` 可直接吃的形状）                 |
| POST   | `/sessions/:id/messages`    | **流式发消息（SSE）**；末条是 assistant 时 = 重新生成 |
| POST   | `/messages/:id/feedback`    | 👍 / 👎 反馈（`null` 清除）                           |

**页面**：`/customer` 与 `/customer/chat`（同一个 ChatPage），详见 `04-b` §4。

**验收**：

- ✅ 连问 5 轮，AI 记得前几轮（集成测试「第二轮带上第一轮的历史」：告诉模型「我叫小林」，
  下一轮问「我叫什么名字」能答出来）
- ✅ SSE 逐字流式：`content-type: text/event-stream` + `x-vercel-ai-ui-message-stream: v1`，
  开流即发 `: stream-open`，阶段心跳 `retrieving → generating`
- ⚠️ **上下文超预算是「预算截断」不是「摘要压缩」**：超预算时保留最近 N 轮
  （`CHAT_MAX_HISTORY_TURNS` 轮数上限 + `CHAT_CONTEXT_TOKEN_BUDGET` token 上限），
  被丢的轮次通过 `data-truncated` part 告知用户「已省略更早的 N 轮」。
  **真摘要压缩（调 LLM 总结早期对话写 `sessions.summary`）是下一轮**——
  字段和 prompt 插槽都已留好（`sessions.summary` 本期恒为 NULL）。
  原来的验收「构造 200 轮对话验证摘要压缩生效」因此**未完成**，不要按已交付对待。
- ✅ 流式 token 计数落库：`messages.usage` 存 `{input_tokens, output_tokens,
  cache_read_tokens, cache_write_tokens}`（取自 LLM 返回的真实 usage，不是本地估算）
- ⏳ **Prompt Caching 命中未验证**：`usage.cache_read_tokens` 字段已经落库了，
  但当前提示词没有打 `cacheControl: {type:'ephemeral'}`，所以这一项必然是 0，
  需要下一轮配合 C3 的提示词版本管理一起做。

**已知限制**：

- 附件 / 图片上传、联网开关、收藏：本期不做
- 跨租户防御：会话一律按 `(id, tenant_id, user_id)` 三元组查，别人的会话按 404 处理
- 进程被 kill 会留下 `status='streaming'` 的僵尸消息；读历史时自动降级为 `failed`

**自动化测试**：

- `tests/unit/token-estimate.test.ts` —— token 估算 + 预算裁剪的纯逻辑（19 个用例）
- `tests/unit/prompt-build.test.ts` —— 资料段编号 / 降级文案 / 提示词不超预算
- `tests/integration/customer-chat.test.ts` —— 会话 CRUD + 鉴权 + **跨租户隔离**（12 个用例，
  零费用，默认跑）+ **真实 LLM 流式**（8 个用例，**会真的调智谱 glm-5.3 并产生费用**，
  用 `CHAT_LLM_E2E=1` 打开）

---

### B2 · RAG 检索 ✅ 已落地（2026-10-20 检索层 / 2026-10-21 对话层）

**需求**：AI 基于上传的文档回答，引用具体片段。

**当前状态**：**完整落地**。检索层（向量 + BM25 → RRF）与对话层（流式回答 + 引用角标）
已端到端接通，B1 的验收「问『年假几天』→ AI 回答里出现「5 天」+ 引用了文档片段」已通过。

**使用技术**：

- Qdrant（向量库，存 embedding）—— ✅ 已实现
- Embedding API（OpenAI 兼容 REST，**独立客户端，不走 Anthropic SDK**；
  实际走哪个模型由 `.env` 的 `LLM_PROVIDER` 决定，dev 用智谱 embedding-3）—— ✅ 已实现
- 关键词检索（BM25，进程内内存索引，启动时从 Qdrant 重建）—— ✅ 已实现
- RRF（Reciprocal Rank Fusion，k=60）融合向量 + BM25 结果 —— ✅ 已实现
- 引用片段经 `data-citations` part 下发，编号与 system prompt 里的 `[n]` **同源**
  （都出自 `shared/prompts/chat/rag-context.ts` 的 `renderRagContext`）—— ✅ 已实现
- 重排序（`bge-reranker-v2-m3`）—— ⏳ 未实现，RRF 只用排名不用分数，语义判别力有限
- 查询改写（可选，把口语化问题改写成检索友好形态）—— ⏳ 未实现

**验收**：

- ✅ 上传一个 .md 文档，内容里有「年假 5 天」这句话
- ✅ 问「年假几天」→ AI 回答里出现「5 天」+ 引用了文档片段（引用卡片显示文档名 / 段号 /
  相关度 / 被哪几路召回，可展开原文）
- ✅ 引用编号不会越界：集成测试断言 AI 回答里出现的每个 `[n]` 都落在实际命中的条数之内
- ✅ 在管理后台问同样问题（用「检索测试」功能），能看到 top N 命中的片段，
  每条标出「语义第 N / 关键词第 N」
- ✅ 检索故障可区分：两路召回全挂时 hybridSearch 返回 `[]` 而不抛错，
  对话链路通过 `onRecallFailure` 回调识别到这种情况，在 `data-citations` 里带
  `retrieval_error`，并在提示词里改用「检索不可用」的措辞，
  **不会伪装成「知识库里没有」**

---

### B4 · 短期 + 长期记忆 ⚠️ 短期已落地，长期未实现

**需求**：多轮对话的上下文；用户偏好的长期记忆。

**当前状态**：

- 短期记忆（MySQL `messages` 表）—— ✅ 已实现，DB 是对话历史的真理来源
- 上下文超预算的**摘要压缩** —— ⏳ 未实现（本期是预算截断，见 B1）
- 长期记忆（`users.preferences` JSON）—— ⏳ 未实现

**使用技术**：

- 短期记忆：MySQL `messages` 表
- 长期记忆：MySQL `users.preferences` JSON 字段

**验收**：

- ✅ 前台用户问多轮 → 刷新页面后继续（历史从 `messages` 表重建，`useChat` 一次灌进去）
- ⏳ 改 `users.preferences` JSON 里的 `style: 'concise'`，下次回答变短