# 07 · 大模型与 Embedding 配置

## 7.1 提供商选型（统一走 Vercel AI SDK + Anthropic 协议）

> 所有 LLM 调用（主对话、评测、内容审核）**主用 Vercel AI SDK**（`ai` + `@ai-sdk/anthropic`）。第三方模型只要支持 Anthropic 兼容协议（智谱 GLM / DeepSeek / Moonshot 都支持），**改 `@ai-sdk/anthropic` 的 model 参数** 就能直接用，不用换 SDK。
> `@anthropic-ai/sdk` 是 Vercel AI SDK 的传递依赖；高级场景（精细控制 cacheControl / 多模态原始格式 / Beta 能力）可以直接调。

| 场景 | 主选 | 备选 | 理由 |
|------|------|------|------|
| 主对话 / 推理 | `anthropic('claude-sonnet-4-5')` | `anthropic('glm-4.5')` / `'deepseek-v3'` / `'moonshot-v1'` | 一个 SDK 全搞定；切换供应商只改 model 参数 |
| Embedding | text-embedding-3-small | bge-m3 / 智谱 Embedding | Embedding 走独立的 REST 协议（不走 Vercel AI SDK） |
| 重排序 | bge-reranker-v2-m3 | Cohere Rerank | 中文效果好 |
| 评测（裁判） | `anthropic('claude-sonnet-4-5')` | 智谱 GLM | 裁判要稳；用 `generateObject` + Zod schema 自动评分 |
| 内容审核 | 自建规则 + Claude（兜底） | — | 敏感审核要可控 |

> **Embedding 与 LLM 用不同协议**：LLM 走 Vercel AI SDK（Anthropic 协议统一），Embedding 走 OpenAI 兼容或原生 REST。这是两套独立的客户端。

## 7.2 密钥管理

- 所有密钥放 `.env`，**不进 git**（`.env.example` 提供模板）
- 密钥按用途分多套（LLM 密钥、Embedding 密钥、审核密钥）
- 本地不存密钥长期状态，每次从 `.env` 加载

## 7.3 限流与降级

- 每个提供商配置 QPS 限制（按模型）
- 主提供商挂了自动切到备选（**改 `@ai-sdk/anthropic` 的 model 参数 + 备选 baseURL**，业务代码不动）