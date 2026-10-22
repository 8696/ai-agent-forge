# 06 · 大模型与 Embedding 配置

## 6.1 提供商选型（统一走 Vercel AI SDK + Anthropic 协议）

> 所有 LLM 调用（主对话、评测、内容审核）**主用 Vercel AI SDK**（`ai` + `@ai-sdk/anthropic`）。第三方模型只要支持 Anthropic 兼容协议（智谱 GLM / DeepSeek / 千问 / MiniMax 都支持），**改 `LLM_PROVIDER` 一切切换**——业务代码不用动。
> `@anthropic-ai/sdk` 是 Vercel AI SDK 的传递依赖；高级场景（精细控制 cacheControl / 多模态原始格式 / Beta 能力）可以直接调。
>
> **Embedding 与 LLM 用不同协议**：LLM 走 Vercel AI SDK（Anthropic 协议），Embedding 走 OpenAI 兼容 REST。两套独立客户端，分别调用。

### 6.1.1 场景 × 选型矩阵

| 场景 | 主选 | 备选 | 理由 |
|------|------|------|------|
| 主对话 / 推理 | `LLM_PROVIDER=minimax` 走 MiniMax-M3 | zhipu / deepseek / qwen / custom | 一个 SDK 全搞定；切换供应商只改 `LLM_PROVIDER` |
| Embedding | `LLM_PROVIDER=zhipu` 走 embedding-3 | minimax (embo-01) / qwen (text-embedding-v3) / custom | dev 偏好用智谱；切 LLM provider 时 Embedding 跟随 |
| 重排序 | bge-reranker-v2-m3 | Cohere Rerank | 中文效果好（⏳ 未实现，见 `07-c` 模块 09） |
| 评测（裁判） | 跟主用 provider（`LLM_PROVIDER`） | — | 裁判要稳；用 `generateObject` + Zod schema 自动评分（Step 10 落） |
| 内容审核 | 自建规则 + LLM（兜底） | — | 敏感审核要可控（Step 12 落） |

### 6.1.2 provider 配置矩阵（per-provider 字段）

`LLM_PROVIDER` 一键切换。每个 provider 在 `.env` 里占 6 行（2 个 baseURL + 2 个 model + key + embedding model）：

| provider | `*_BASE_URL`（OpenAI 兼容，给 Embedding） | `*_ANTHROPIC_BASE_URL`（Vercel AI SDK） | `*_EMBEDDING_MODEL` | 维度 |
|---|---|---|---|---|
| minimax | `https://api.minimaxi.com/v1` | `https://api.minimaxi.com/anthropic` | `embo-01` | 1024 |
| zhipu | `https://open.bigmodel.cn/api/paas/v4/` | `https://open.bigmodel.cn/api/anthropic` | `embedding-3` | 2048（默认；支持 1024 / 768 / 512） |
| deepseek | `https://api.deepseek.com` | `https://api.deepseek.com/anthropic` | `（不支持）` | — |
| qwen | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `https://dashscope.aliyuncs.com/apps/anthropic` | `text-embedding-v3` | 1024 |
| custom | `<用户自填>` | `<用户自填>` | `<用户自填>` | 1536（默认按 OpenAI text-embedding-3-small 算） |

> **维度写死在 `src/config.ts:PROVIDER_EMBED_DIMENSIONS`**——加新 provider / model 时同步更新这张表，**Qdrant collection 创建时按这个维度**。
> 改 provider 维度（譬如从 zhipu 切到 minimax，2048 → 1024）必须 **DELETE Qdrant collection 重建**：
> ```bash
> curl -X DELETE http://<QDRANT_URL>/collections/documents
> ```
> **忘了删会怎样**：`src/rag/embedding.ts` 在拿到向量的那一刻就做维度校验，
> 不一致直接抛错，错误信息里明确告诉你「换 embedding 模型 / provider 后必须重建 Qdrant collection」。
> 这是刻意的——把故障拦在写入之前，而不是等 Qdrant 报一个更难懂的 dimension error。
>
> `LLM_EMBEDDING_MODEL` 可以只覆盖 model id 而不改 provider，此时维度表也要跟着对；
> 智谱 `embedding-3` 支持 1024/768/512，显式指定这些变体时**必须同步改 `PROVIDER_EMBED_DIMENSIONS.zhipu`**。

### 6.1.3 全局 override

- `LLM_MODEL`：留空 = 用该 provider 的 `*_ANTHROPIC_MODEL`；填写则所有 provider 的 LLM 都走这个 model id
- `LLM_EMBEDDING_MODEL`：留空 = 用该 provider 的 `*_EMBEDDING_MODEL`；填写则 Embedding 都走这个 model id
- 调高阶用法（譬如想用智谱 LLM 但 MiniMax embedding）：暂时不支持——`LLM_PROVIDER` 一切切换

### 6.1.4 切换 provider 的标准操作

1. `.env` 改 `LLM_PROVIDER=<新 provider>`
2. 填该 provider 的 `*_API_KEY`（其它 provider 的 key 可保留做备选探活）
3. `yarn tsx scripts/sync-env.ts` 同步两文件
4. **如果新 provider 维度跟当前不同**：DELETE Qdrant collection 重建（见 6.1.2 末尾命令）
5. 重启后端
6. 验证：`yarn tsx scripts/probe.ts`（MySQL + Anthropic 协议 LLM 探活）+ `curl http://localhost:3000/api/_dev/probe/llm`

## 6.2 密钥管理

- 所有密钥放 `.env`，**不进 git**（`.env.example` 提供模板）
- 同步规则见 `.env` 顶部注释 + `scripts/sync-env.ts`：
  - `*_API_KEY / *_PASSWORD / *_SECRET`：.env 写真值，.env.example 留空
  - 非 secret 配置：.env.example 是本地默认（localhost / OpenAI 默认等）；dev 用远程基础设施时 .env 可 override
- 密钥按用途分多套：每个 provider 一套（含 Anthropic 协议 + OpenAI 兼容 Embedding 共用同一个 key）
- 本地不存密钥长期状态，每次从 `.env` 加载

## 6.3 限流与降级

- 每个 provider 配置 QPS 限制（按 model；provider 自带限流时遵循 provider 文档）
- 主 provider 挂了自动切到备选（**改 `LLM_PROVIDER` 切到下家 + 备选 `*_ANTHROPIC_BASE_URL`**，业务代码不动）
- 当前 MVP 不做自动 failover（要在 server.ts 写 retry + 探测逻辑），人工切

## 6.4 思考模式（reasoning）的 provider 支持情况

> **2026-10-21 B1 落地时实测**，结论可能随 provider 升级变化，换 provider 前先复测。

对话链路的思考模式由 `CHAT_THINKING_BUDGET_TOKENS` 控制（**默认 0 = 关闭**）。
开启后 `src/services/chat.ts` 会给 `streamText` 传：

```ts
providerOptions: { anthropic: { thinking: { type: 'enabled', budgetTokens: N } } }
```

`@ai-sdk/anthropic` v4 的 provider options schema 支持
`thinking.type: 'enabled' | 'adaptive' | 'disabled' | 'between_tools'`
（见 `node_modules/@ai-sdk/anthropic` 的 d.ts）。但**各家网关是否透传这个参数不一样**：

| provider | 实测结果（2026-10-21，dev 用智谱 glm-5.3） |
| -------- | ------------------------------------------------ |
| 智谱（`ZHIPU_ANTHROPIC_BASE_URL`） | **默认就会返回 `reasoning-start` / `reasoning-delta`**，不需要打开开关 —— 前端「💭 思考过程」默认就能看到内容。`CHAT_THINKING_BUDGET_TOKENS=0` 时我们不传 `thinking` 参数，模型仍自带推理 |
| 其他 provider | ⏳ 未实测。可能是忽略参数（无害），也可能 400（会走流内 error 降级） |

> **为什么默认关着**：不传未知参数最安全。只要 provider 自己愿意吐 reasoning，
> `toUIMessageStream({ sendReasoning: true })` 就照样能把 `ReasoningUIPart` 送到前端，
> 所以「关着」不等于「看不到思考过程」——只是不由我们控制推理预算。
>
> 真要在某个 provider 上开，显式设 `CHAT_THINKING_BUDGET_TOKENS=2048`，
> **并在目标 provider 上验一轮**，别假设它认。

### ⚠️ 系统提示词必须走 `system` 参数，不能塞进 `messages` 的 system 角色

**2026-10-21 实测**：把系统提示词写成 `messages: [{ role: 'system', ... }]`，
智谱直接 400：

```
Invalid prompt: System messages are not allowed in the prompt or messages fields.
Use the instructions option instead.
```

Anthropic 原生协议里 `system` 既可以是顶层字段，也可以是 messages 里的首条；
但**很多「Anthropic 兼容」网关只实现了前者**。SDK 把 `streamText({ system })`
映射成 `instructions` 字段，所以正确写法是：

```ts
// ✅ 所有 provider 都能跑的写法
streamText({ model, system: { role: 'system', content: prompt }, messages: history })
```

> 为什么传对象而不是字符串：为了挂 `providerOptions.anthropic.cacheControl`
> 给提示词开 Prompt Caching。**智谱上这个参数实测不生效**（它把提示词映射到
> `instructions`，而 `cache_control` 只对 messages 里的 content block 有意义），
> 所以 `cache_read_tokens` 仍是 0；原生 Anthropic 端点上应该可用（未实测）。
> 换 provider 前建议先跑一轮 `POST /api/v1/admin/config/llm/test` 再开这个开关。
