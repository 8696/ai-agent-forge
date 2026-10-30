# AgentForge

> **多租户的 AI Agent 平台。** 文档问答是它的第一个能力，工具调用、多代理协作、状态机工作流、长期记忆都已经落地。
>
> 上传 PDF / Markdown / TXT → 结构感知切块 + 向量化 → 前台用自然语言提问 → 流式回答 + 可点击的引用来源。

[![TypeScript](https://img.shields.io/badge/TypeScript-7-blue.svg)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-%E2%89%A522.4-green.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-lightgrey.svg)](#license)

---

## 目录

- [这是什么](#这是什么)
- [功能总览](#功能总览)
- [架构](#架构)
- [技术栈](#技术栈)
- [快速开始](#快速开始)
- [怎么和 AI 交互](#怎么和-ai-交互)
- [配置](#配置)
- [核心能力](#核心能力)
- [API 一览](#api-一览)
- [目录结构](#目录结构)
- [开发与测试](#开发与测试)
- [已知限制](#已知限制)
- [文档索引](#文档索引)
- [License](#license)

---

## 这是什么

AgentForge 是一个可以自托管的多租户 AI 平台：**平台方建租户 → 租户管理员配知识库和模型 → 终端用户在前台提问**。

四套互相独立的子系统，各自一套鉴权命名空间：

| 入口 | 路径 | 谁用 | 鉴权 |
|---|---|---|---|
| 租户前台 | `/customer` | 终端用户 | JWT（customer 角色） |
| 公开挂件 | `/widget/:tenantCode` | 嵌到别人网站上的访客 | 签名 token（免登录） |
| 对外 API | `/api/v1/public/*` | 客户的业务系统 | API Key（read / write / admin 三档） |
| 租户后台 | `/admin` | 租户管理员 | JWT（admin 角色） |
| 平台方后台 | `/system` | SaaS 平台运营 | JWT（system 用户，独立表） |

它不是一个 demo —— 底下这些都已经实现并有测试守着：

- **租户隔离是运行时强制的**，不是「靠人记得加 `tenant_id` 过滤」：请求级租户上下文 + Sequelize 全局钩子自动补过滤，忘了也不会跨租户。
- **切块是结构感知的**，不是「拍平成字符再滑窗」：Markdown 走 AST、PDF 保页边界，标题不跨块、表格切片重复表头、代码切片保留围栏。
- **检索是真混合的**：向量 + BM25 两路召回、RRF 融合、可选重排，每一路挂掉都自动降级而不是整体失败。
- **工具有人工闸门**：敏感操作（提交退款 / 改地址 / 建工单）会停下来等用户点确认，模型改参数也不重复问。
- **提示词是可运营的**：多版本、草稿 → 发布 → 回滚，发布后自动跑一次小规模回归评测，还能 A/B 对比两个版本。
- **每一轮对话都有迹可循**：trace + span 树、成本记账、错误率 / p95 / 单条成本告警。

---

## 功能总览

### 知识库

- 上传 PDF / Markdown / TXT，**同步**切块 + 向量化 + 入 Qdrant
- 文档列表 / 重新索引 / 删除
- **检索测试页**：拿真实 query 打进去，看命中了哪些块、两路各排第几、重排有没有生效
- **切片浏览页**：看一篇文档被切成的**每一块**（字数 / 标题路径 / 正文），多篇并排对比
- **切片可以直接人工编辑**：改文字 / 在光标处拆分 / 合并连续几块 / 还原成程序生成的版本

> 最后这条是「知识库校对台」而不是「全文预览器」——正文截断 + 折叠，不是给租户绕过问答读文档的后门。
> 人工编辑有权威副本（MySQL `document_chunks` 表），Qdrant 只是检索索引；改完自动重算向量，没改的块复用旧向量。

### 对话

- 多轮会话 + **SSE 流式**回答，引用卡片点开就能看原文
- 「思考模式」开关（推理型模型的思考过程单独展示）
- 停止 / 复制 / 重新生成 / 👍👎 / 📌 收藏（会话级 + 消息级）
- 超长会话自动**摘要压缩** —— 被裁掉的早期轮次折成摘要，下一轮注入

### 工具与工作流

- 8 个内置工具（订单 / 商品 / 物流 / 优惠券 / 知识库清单 / 退款 / 改地址 / 售后工单）
- 租户可在后台注册、启停、**改描述**（描述就是给模型看的，改完下一轮立刻生效）
- 敏感工具走 **HITL 人工确认**：模型说「我要退款」→ 前端弹卡片 → 用户点确认才真的执行
- 3 条状态机工作流（退款申请 / 收货地址修改 / 售后工单），前置步骤没做会被挡住并提示模型先做什么

### 记忆

- 用户长期记忆：画像 / 偏好 / 事实 / 情境 四类，三级更新（正则预筛 → LLM 抽取 → 人工改）
- 注入时**按相关性排序**（向量匹配当前问题），不是固定顺序堆上去
- 租户后台能看 / 改 / 归档本租户每个用户的记忆；用户自己也能改、能一键关掉自动记忆

### 运维

- **观测**：trace / span 树（多代理的调用树看得出层级）、成本分析 4 维拆解、p95 / 错误率 / 单条成本三条告警规则
- **评测**：评测集 + LLM-as-Judge 四维打分 + 后台异步跑批 + 分数跌 10% 告警 + 两个提示词版本的 A/B 对比
- **成本**：每次调用的 token 和花费落 `cost_logs`，租户月度预算，超了写告警（可配置成直接拦截）

---

## 架构

```
┌───────────────────────────────────────────────────────────────────┐
│  客户端                                                            │
│  /customer 前台 · /widget/:tenantCode 挂件 · 对外 REST API         │
│  /admin 租户后台 · /system 平台方后台                              │
└───────────────────────────────────────────────────────────────────┘
                                │
┌───────────────────────────────────────────────────────────────────┐
│  网关层  Koa  (src/gateway/)                                      │
│  四套互相独立的鉴权命名空间：system / admin / customer / public     │
│  JWT(用户) · API Key(对外) · 挂件签名 token · 限流 · 审计 · 错误兜底 │
└───────────────────────────────────────────────────────────────────┘
                                │
┌───────────────────────────────────────────────────────────────────┐
│  对话编排  (src/services/chat.ts)                                 │
│                                                                   │
│   查询改写 → 混合检索 → 上下文装配 → 工具循环 → 流式输出 → 落库       │
│                                                                   │
│   上下文装配 = 基础提示词 + 工具声明 + 工作流进度                    │
│              + 会话摘要 + 用户记忆 + 检索资料段                      │
└───────────────────────────────────────────────────────────────────┘
                                │
┌──────────────────────────────┬────────────────────────────────────┐
│  能力层                      │  横切关注点                         │
│  RAG 检索   (src/rag/)       │  成本记账  (cost_logs)              │
│  工具       (src/tools/)     │  链路追踪  (traces / spans)         │
│  记忆       (src/services/)  │  评测      (LLM-as-Judge)           │
│  工作流     (src/workflows/) │  安全      (脱敏 / 审核 / 注入检测)   │
│  多代理     (src/agents/)    │  可靠性    (重试 / 熔断 / failover)  │
└──────────────────────────────┴────────────────────────────────────┘
                                │
┌───────────────────────────────────────────────────────────────────┐
│  数据层                                                            │
│  MySQL 8.0（25 张表）· Qdrant（向量）· 本地文件 data/uploads/       │
└───────────────────────────────────────────────────────────────────┘
                                │
┌───────────────────────────────────────────────────────────────────┐
│  外部依赖                                                          │
│  LLM（Anthropic 协议）· Embedding（OpenAI 兼容）· 重排（Cohere 兼容）│
└───────────────────────────────────────────────────────────────────┘
```

### 一次对话发生了什么

```
用户提问
  ↓  网关：JWT 校验 → 限流 → 注入检测 → 脱敏
  ↓  查询改写（可选）：「我入职三个月能休几天年假」→「年假 天数 入职时长」
  ↓  混合检索：向量路 + BM25 路 → RRF 融合 → 重排（可选）→ topK
  ↓  上下文装配：按 token 预算切分（资料 / 摘要 / 记忆 / 历史）
  ↓  组装系统提示词（资料编号 [1][2] 与前端引用卡片同源）
  ↓  streamText + 工具循环（AI SDK 自动循环，最多 5 步）
  │     └ 工具执行 → 闸门判断（allow / await / blocked / reject）
  ↓  SSE 推流：text-delta + data-citations + data-tool-call
  ↓  落库：messages.parts / usage / status
  ↓  记账 + trace 收尾 + 记忆抽取（fire-and-forget）
```

---

## 技术栈

| 层 | 选型 |
|---|---|
| 运行时 | Node.js ≥ 22.4，ESM，TypeScript 7（strict） |
| Web 框架 | Koa 3 + @koa/router + @koa/cors |
| AI | Vercel AI SDK v7（`@ai-sdk/anthropic` + `ai`）+ Anthropic 协议 |
| 存储 | MySQL 8.0（Sequelize 6 + sequelize-typescript）+ Qdrant（REST client） |
| 迁移 | Umzug（37 个迁移，`yarn migrate` 只跑 pending） |
| 文档解析 | `pdf-parse` v2 + `mdast-util-from-markdown` + `micromark-extension-gfm` |
| 中文分词 | `nodejieba`（BM25 那一路） |
| 校验 | zod 4（环境变量 + 所有请求体） |
| 日志 | pino 10 + pino-pretty |
| 前端 | React 19 + Vite 8 + Ant Design v6 + React Router v7 |
| 图表 | ECharts 6（`echarts-for-react`） |
| 流式客户端 | `@ai-sdk/react` 的 `useChat` |
| 鉴权 | bcrypt 6 + jsonwebtoken + `nanoid`（API Key） |
| 工具链 | ESLint 10 + Prettier 3 + Vitest 5 + Playwright 1.64 |

**模型供应商可一键切换**（`LLM_PROVIDER`），已内置 MiniMax / 智谱 / DeepSeek / 千问 / 自定义网关五套配置。
LLM 统一走 Anthropic 协议，Embedding 统一走 OpenAI 兼容 REST —— 两套协议互相独立，换供应商只改 `.env`，不改代码。

---

## 快速开始

### 前置

- Node.js ≥ 22.4，Yarn ≥ 1.22
- Docker（用来跑 MySQL + Qdrant）
- 一个 LLM 的 API Key（以及一个能算 Embedding 的 —— DeepSeek 不提供）

### 三步跑起来

```bash
# ① 装依赖
yarn install

# ② 准备配置：复制模板，填 LLM 密钥和 JWT_SECRET
cp .env.example .env
```

`.env` 里最少要改这三处：

```bash
LLM_PROVIDER=zhipu          # minimax / zhipu / deepseek / qwen / custom
ZHIPU_API_KEY=你的密钥
JWT_SECRET=至少 32 字符的随机串
```

```bash
# ③ 起中间件 + 起服务
docker compose up -d     # MySQL 8.0 (3306) + Qdrant (6333)
yarn dev                 # 后端 :3000（含自动迁移） + 前端 :5173
```

打开 <http://localhost:5173>，按登录态分流到对应子系统。

### 造点数据看看

```bash
yarn seed        # 幂等：1 个平台方账号 + 2 个租户（acme / globex）+ 各一个 admin / customer / API Key
yarn e2e:login   # 走一遍 5 个登录端点，把 JWT 写进 .e2e-tokens.json（e2e 用）
```

`yarn seed` 会把全部凭据打印到控制台：

| 角色 | 账号 | 密码 |
|---|---|---|
| 平台方 | `platform-admin@local.test` | `PlatformAdmin-123!` |
| acme 管理员 | `admin@acme.test` | `AcmeAdmin-123!` |
| acme 终端用户 | `alice@acme.test` | `AcmeCustomer-123!` |
| globex 管理员 | `admin@globex.test` | `GlobexAdmin-123!` |
| globex 终端用户 | `bob@globex.test` | `GlobexCustomer-123!` |

> ⚠️ 这套凭据只用于本地开发，**生产环境千万别用**。

### 访问入口

| 入口 | 地址 |
|---|---|
| 租户后台 | <http://localhost:5173/admin> |
| 租户前台 | <http://localhost:5173/customer> |
| 平台方后台 | <http://localhost:5173/system> |
| 公开挂件 | <http://localhost:5173/widget/acme> |
| 后端 API | <http://localhost:3000> |
| 健康检查 | <http://localhost:3000/api/health> |
| Qdrant Dashboard | <http://localhost:6333/dashboard> |

---

## 怎么和 AI 交互

三种方式，**走的是同一条对话链路**（同一个检索器、同一套提示词、同一套预算 / 限流 / 审核 / 记账 / 观测）。

### 1. 前台聊天页（终端用户）

`/customer/chat` —— 走 Vercel AI SDK 的 UI message stream（SSE）。

前端用 `useChat` 消费，`POST /api/v1/customer/sessions/:id/messages`，body 是 AI SDK 的消息协议：

```jsonc
{
  "messages": [
    { "id": "m1", "role": "user", "parts": [{ "type": "text", "text": "年假有几天？" }] }
  ],
  "thinking": false          // 可选：这一轮要思考模式
}
```

流里除了正文，还会有这些 data part（都会落进 `messages.parts`，刷新后卡片还在）：

| part | 含义 |
|---|---|
| `data-status` | 阶段提示（正在检索 / 正在组织回答），transient，不落库 |
| `data-citations` | 检索命中的片段 + 编号（编号与模型写的 `[1]` 严格一致） |
| `data-tool-call` | 一次工具调用（名称 / 入参 / 结果），前端渲染成可展开的卡片 |
| `data-truncated` | 更早的对话被裁掉了（开了摘要就是「正在整理成摘要」） |
| `data-moderation` | 输出被审核拦下，前端把气泡换成拦截文案 |

### 2. 对外 REST API（客户的业务系统）

API Key 鉴权，三档 scope：

| scope | 能做什么 |
|---|---|
| `read` | 只能 `GET /search` —— 查知识库，**不调 LLM、不花钱、不留会话** |
| `write` | `read` + 发起对话（默认档） |
| `admin` | `write` + 管理本租户知识库（列文档 / 上传 / 删文档） |

```bash
# 建会话问一次
curl -X POST http://localhost:3000/api/v1/public/chat \
  -H "Authorization: Bearer ak_xxx" \
  -H "Content-Type: application/json" \
  -d '{"question":"年假有几天？"}'
```

```jsonc
{
  "session_id": "…",     // 带上它就能续上下文
  "message_id": "…",
  "answer": "正式员工入职满 1 年不满 10 年的，年假 5 天[1]。",
  "citations": { "hits": [ /* 命中片段 */ ], "retrieved": true },
  "moderation": null,
  "tool_calls": []       // 这一轮 AI 调了哪些工具
}
```

```bash
# 流式
curl -N -X POST http://localhost:3000/api/v1/public/chat/stream \
  -H "Authorization: Bearer ak_xxx" \
  -H "Content-Type: application/json" \
  -d '{"question":"年假有几天？","session_id":"…"}'

# 只读检索（不花钱）
curl "http://localhost:3000/api/v1/public/search?q=年假&top_k=5" \
  -H "Authorization: Bearer ak_xxx"
```

### 3. 公开挂件（嵌到别人网站）

`/widget/:tenantCode` —— 免登录。匿名会话靠签名 token 认领（`w1.<session_id>.<HMAC>`，走 `X-Widget-Token` 头、不进 URL），关掉浏览器再打开历史还在。

挂件页和 REST API 的差别只有「鉴权方式」，对话链路完全一样；HITL 的人工确认在挂件里也能点。

### 4. 让 AI 调工具（人工确认怎么走）

```
用户：「我要退款，订单 SO-2024-0817」
  ↓
AI 调 query_order_status（只读，直接执行）
  ↓
AI 调 submit_refund_request（敏感 → 闸门拦下）
  ↓
闸门返回 await → 流里写一条 data-tool-call → 前端弹卡片：「确认提交退款申请」
  ↓
用户点【确认执行】→ 批准令牌记进 sessions.metadata.approved_tool_calls（30 分钟过期）
  ↓
下一轮系统提示词主动提醒模型「用同样的参数再调一次」
  → 这次闸门放行 → 真的执行 → 结果回灌上下文 → AI 继续作答
```

几个细节：

- 模型改了参数 → 闸门把「用户已确认的那组参数」回传给它，用户不用再点一次
- 用户点【取消】→ 闸门回「用户拒绝」，**不再问第三次**
- 批准令牌 30 分钟过期；工作流账本在 `missions` 表，两者生命周期不同，所以是两张表

### 5. 改 AI 的「性格」和「能力」

| 想改什么 | 在哪改 | 生效 |
|---|---|---|
| 系统提示词正文 | `/admin/prompts`（多版本：草稿 → 发布 → 回滚） | 发布后下一轮生效，不用重启 |
| 用哪个模型、温度、输出上限、思考预算 | `/admin/models`（多条，可启用切换，可配备用模型） | 保存后立即生效 |
| 检索召几条、上下文预算、记忆开关…… | `/admin/settings`（通用配置 KV） | 保存后立即生效 |
| 工具的描述（决定模型调不调它） | `/admin/tools` | 下一轮生效 |
| 提示词正文占位符 | `{{tenantName}}` 会被替换成租户名 | — |

**提示词发布后会自动跑一次小规模回归**（前 10 题，异步，永不阻塞发布）。跑批结果能在「评测结果」页看，还能在「版本对比」页做 A/B。

---

## 配置

配置分两层：**平台级**在 `.env`（进程重启生效），**租户级**在后台（保存即生效）。

### 平台级（`.env`）

`.env` 和 `.env.example` 是**同一份东西的两副面孔**：同一组 key、同一顺序、同一段注释，只有值不同。哪个 key 该存在的唯一依据是 `src/config.ts` 的 `envSchema`。

常改的几组：

| 组 | Key | 说明 |
|---|---|---|
| 数据库 | `MYSQL_HOST` `MYSQL_PORT` `MYSQL_USER` `MYSQL_PASSWORD` `MYSQL_DB` | 拆开的五个，**不是** `MYSQL_URL` |
| 向量库 | `QDRANT_URL` `QDRANT_COLLECTION` | 默认 `http://localhost:6333` / `documents` |
| 模型 | `LLM_PROVIDER` `LLM_MODEL` `LLM_EMBEDDING_MODEL` | `LLM_MODEL` 留空 = 用该 provider 的默认模型 |
| 各家密钥 | `MINIMAX_*` `ZHIPU_*` `DEEPSEEK_*` `QWEN_*` `CUSTOM_*` | 每家一套 `API_KEY` / `BASE_URL` / `*_MODEL` / `*_ANTHROPIC_BASE_URL` / `*_EMBEDDING_MODEL` |
| 鉴权 | `JWT_SECRET` `JWT_EXPIRES_IN` | `JWT_SECRET` **生产必须改**，至少 32 字符 |
| 切块 | `CHUNK_SIZE` `CHUNK_OVERLAP` | 默认 800 / 150（**平台级，不是租户可配**） |
| 对话 | `CHAT_*` | 上下文预算、轮数上限、topK、温度、输出上限、SSE 心跳…… |
| 重排 | `RERANK_API_URL` `RERANK_MODEL` `RERANK_CANDIDATES` | `RERANK_API_URL` 留空 = 不做重排（走纯 RRF） |
| 成本 | `COST_BUDGET_BLOCK` `COST_PRICE_TABLE` | 超预算默认只告警，`COST_BUDGET_BLOCK=true` 才拦 |
| 安全 | `SECURITY_*` `TENANT_SCOPE_ENFORCE` | 注入检测 / 敏感词 / 租户隔离运行时强制 |

改完跑一次校验：

```bash
yarn env:check   # 只校验，结构漂了退出码 1
yarn env:sync    # 按 .env.example 的结构同步 .env
```

`tests/unit/env-consistency.test.ts` 守着同一套不变量 —— 改了 `envSchema` 忘了改这两个文件，测试会红。

### 租户级（后台 `/admin/settings`）

元信息在代码里（`SETTINGS_REGISTRY`），值在 `tenant_settings` 表，只存租户改过的那些。**每轮对话读一次库，改完不用重启**。

| 分类 | 配置项 |
|---|---|
| 知识库 | `retrieval_top_k` `max_history_turns` `retrieval_token_budget` `rerank_enabled` `query_rewrite_enabled` |
| 成本 | `context_token_budget` `max_input_chars` `monthly_token_budget` `alert_p95_latency_ms` `alert_error_rate` `alert_single_cost_usd` |
| 模型 | `thinking_budget_tokens` `multi_agent_enabled` |
| 安全 | `rate_limit_per_minute` |
| 记忆 | `memory_enabled` `memory_top_k` `memory_token_budget` `memory_relevance_enabled` `summary_enabled` `summary_token_budget` |
| 首页 | `home_welcome_message` `home_suggested_questions` |
| 提示词 | `prompt_version`（隐藏，由提示词页的发布 / 回滚自动维护） |

**留在 `.env` 不给租户的**：加密密钥、SSRF 开关、上下文总预算、SSE 心跳、重排端点与凭据 —— 这些是平台级安全 / 成本边界。

### 两个开关值得单独说

- **重排**：`RERANK_API_URL` 留空 = 不做重排（纯 RRF 排序）；配好地址即生效。协议是 Cohere 兼容的 `POST {地址}`，自建 `bge-reranker-v2-m3`、硅基流动、Jina、Cohere 都吃这个格式。调不通自动降级回 RRF，检索整体不挂。
- **查询改写**：默认**关闭**。每轮多一次 LLM 调用（多 1~3 秒 + 一份花费），短问题（「年假几天」）改写基本没收益 —— 只有「问法跟原文差很远」时收益才明显。

---

## 核心能力

### 结构感知切块

旧版是「把文档拍平成字符 → 按 800 字滑窗 → 尽量切在段落/句子边界」。病根不在切点选得不好，而在**结构信息在进切块器之前就没了**：标题留在上一块末尾、正文在下一块；表格被劈成两半（后半截没有列名）；代码块被劈开。

现在改成三层：

1. **元素层** —— Markdown 走 **AST 不用正则**（`mdast-util-from-markdown` + `micromark-extension-gfm`；Setext 标题 `===` 形式正则根本认不出，AST 认得出）；PDF **保住页边界**（页是 PDF 仅剩的结构信号）；TXT 按启发式猜标题（只认强模式：`第一章` / `一、` / `（一）` / `1.2 `）
2. **按标题分节** —— 标题开启新节，**块不跨节**
3. **节内按元素聚合成块** —— 装不下才在元素内部切，且按类型分别切

保证（有单测守着）：

| 不变量 | 做法 |
|---|---|
| 块长 ≤ `CHUNK_SIZE`（含面包屑和重叠区） | 面包屑最多占 1/3，重叠区预留 1/4 |
| 块不跨节 | 分节后再打包 |
| 表格切片重复表头 | `splitTable` 每片都拼一遍表头 + 分隔行 |
| 代码切片不重复行、每片闭合 | `splitCode` 每片补上「首行围栏（含语言标记）+ 本片行 + 收尾围栏」 |
| 段落不切半句 | 按句边界切 |
| 重叠区按元素携带 | 段落带整块或句子对齐的尾巴；表格带「表头 + 尾部行」；代码**整体带走**（带得下才带，半截代码 + 开着的围栏比不带更糟） |

每块开头拼**标题路径面包屑**（`产品手册 > 退款政策`），这样一节切成 5 块时每块都知道自己在哪。块上还带「第 i/N 块」（本节第几块 / 共几块）→ 进 Qdrant payload（不进文本，不污染向量）。

> ⚠️ **存量文档不会自动重切** —— 切法改了只影响之后上传的文档。老文档要逐个「重新索引」才会按新规则重切（重新索引复用磁盘上的原文件）。**全量重跑 = 一次全量 embedding 的钱**。

### 混合检索

```
query → embedding → Qdrant 向量召回 ┐
       query → BM25 关键词召回（nodejieba 分词）┴→ RRF 融合 → [重排] → topK
```

- **为什么用 RRF 而不是加权求和**：cosine 在 [0,1]、BM25 分无上界，两者量纲完全不同，任何加权系数都是拍脑袋。RRF（Cormack et al. 2009）只用**排名**不用分数，天然免疫量纲问题。
- **BM25 补的是精确匹配的洞**：向量擅长「语义相近但用词不同」，对专有名词 / 编号 / 人名很不可靠（问「订单 SO-2024-0817 怎么处理」时，向量可能召回一堆语义相近的订单说明却漏掉这一条）。
- **两路各自兜底**：向量库挂了只剩关键词，关键词索引没重建只剩向量。**都挂才降级为无资料作答**。
- **重排在融合之后、截断之前** —— RRF 只看排名，对语义相关性判别力有限；重排模型把 query 和候选逐条对读再打分。重排不可用自动降级回 RRF。
- **BM25 是进程内内存索引**，重启时从 Qdrant 的 payload 重建。

### 上下文装配

单轮上下文有一份**总 token 预算**（默认 8000），按固定比例切给三块：

```
可用 = 总预算 × (1 - 安全垫)
  资料段 ≤ retrieval_token_budget
  摘要段 ≤ summary_token_budget
  记忆段 = 实际占用
  历史   = 可用 - 上面三块 - system_token_budget
```

被裁掉的早期轮次会调一次 LLM 折成**会话摘要**写进 `sessions.summary`，下一轮注入（并记一个边界，之后的原文不再重复喂，摘要和原文两种说法并存会让模型混乱）。

### 工具与工作流

- **代码在 `src/tools/builtin/`，注册在数据库** —— 加一个内置工具 = 加一个条目，不改表结构、不用改注册流程，租户刷新一下下拉框就能选到
- **描述是给模型看的** —— 租户能改描述 = 能「调教模型调不调它」
- **HITL 人工确认**：敏感工具在执行前被闸门拦下，用户点确认才执行；批准记录寄在 `sessions.metadata.approved_tool_calls`（30 分钟 TTL）
- **工作流**（`src/workflows/`）：流程定义是**数据**，引擎只管按定义执行 —— 加一条流程 = 加一条定义，不改引擎。三条流程（退款申请 / 收货地址修改 / 售后工单）都是线性的
- 闸门有四种结果：`allow` / `await`（等人点头）/ `blocked`（前置步骤没满足，提示模型先做什么）/ `reject`（用户拒绝，不再问第三次）

### 多代理协作（监督者模式）

主 agent 通过内置工具 `delegate_to_agent` 把子任务派给三个专业子代理（订单 / 政策 / 优惠），子代理查完把结论回灌，主 agent 综合作答。

- 共享状态是**引擎直接注入**的（`renderSharedState`），不是主 agent 转述
- 调用树在 trace 里看得出层级（`spans.parent_span_id`）
- ⚠️ **子代理只拿只读工具** —— 写操作留在主 agent，因为那些要走 HITL 闸门，而闸门挂在对话链路的工具执行层上，子代理不在覆盖范围内。让子代理拿着敏感工具跑 = 开了一条绕过用户确认的后门

### 评测

- 评测集（JSONL）+ **LLM-as-Judge 四维打分**（准确性 / 完整性 / 风格 / 安全，各 0~5 分）
- 跑批是**后台异步**的（返 202 + run id），单次最多 50 题（一条题 = 2 次 LLM 调用，这是成本闸门）
- 提示词**发布 / 回滚后自动跑前 10 题**（异步，永不阻塞发布）
- **A/B 对比**：跑批时可指定 `prompt_version`（不传 = 跟随当前生效版本，传 `null` = 显式用内置默认），然后 `GET /evaluation/compare` 拿四维分差 + 逐题谁更好谁更差
- ⚠️ 指定的版本不存在直接 400，**不静默回落默认** —— 回落会让对比结果骗人
- ⚠️ 线上对话和评测**走同一个检索入口**（`planRetrieval()`），口径靠结构保证一致 —— 否则租户改了开关，评测跑的检索就不是线上那一套，分数不能代表线上表现

### 观测

- 一次对话一条 **trace**，内部 5 段 **span**（检索 / LLM / 工具 / 记账 / …），支持父子关系（多代理的调用树）
- `logs/trace-YYYY-MM-DD.jsonl` 留一份本地副本
- 成本分析按 **4 个维度**拆解（时间 / 租户 / 用户 / 模型），带 p95 延迟 / 错误率 / 单条成本
- 三条告警规则，**阈值租户可配**（填 0 = 关掉这一条）

### 安全

| 层 | 做什么 |
|---|---|
| 脱敏 | 身份证 / 银行卡 / 手机号 → `***`，**没有开关**（写进历史库前的最后一道防线，能关就等于允许把身份证明文存库） |
| 敏感词 | 暴力 / 色情 / 政治 / 歧视 |
| 注入检测 | 规则层常开 + 可选的大模型二次确认（`confirm` / `always` / `off`） |
| 输出审核 | SSE 已经把字节发出去了，做不到「一个字节都不给浏览器」，只能「原文不落库 + 前端换文案」 |
| 限流 | 进程内 Map，租户 + 用户双维度，429 带 `Retry-After` |
| 熔断 | 按 `provider|base_url` 分桶，closed / open / half-open 三态 |
| 审计 | 所有写操作留痕（密码永不进 `details`） |

### 租户隔离

三道互补的防线：

1. **运行时钩子** —— 请求级租户上下文 + Sequelize 的 `beforeFind` / `beforeCount` / `beforeBulkUpdate` / `beforeBulkDestroy`，查询发出前自动补 `tenant_id` 过滤；显式查了别的租户 → 抛 `TenantIsolationError`
2. **静态约束测试** —— 扫 `src/` 里所有租户级模型的查询，没带租户过滤就让测试红；确实不需要带的必须逐条登记在白名单并写清理由，白名单有过期条目也红
3. **代码评审** —— 「这个查询本来就不该带租户过滤」这种判断

平台方（system）**不设上下文** —— 它本来就要跨租户看数据。

---

## API 一览

四个命名空间，**鉴权互相独立**（JWT 打过来 401，反之亦然）。

### 租户后台 `/api/v1/admin`（admin JWT）

```
POST   /login                        登录
GET    /me                           当前用户
POST   /change-password              改密码

GET    /knowledge                    文档列表
POST   /knowledge                    上传（multipart）
POST   /knowledge/:id/reindex        重新索引
DELETE /knowledge/:id                删除
GET    /knowledge/:id/chunks         切片浏览（分页）
PATCH  /knowledge/:id/chunks/:index  改一块
POST   /knowledge/:id/chunks/:index/split   在光标处拆分
POST   /knowledge/:id/chunks/merge   合并连续几块
POST   /knowledge/:id/chunks/:index/reset   还原成程序生成的文本
POST   /knowledge/search             检索测试

GET    /config/models                模型列表
POST   /config/models                新建模型
PUT    /config/models/:id            编辑
POST   /config/models/:id/activate   启用
DELETE /config/models/:id            删除
POST   /config/models/:id/test       连通性测试
GET    /config/settings              通用配置
PUT    /config/settings              保存通用配置
GET    /config/prompts               提示词版本列表
POST   /config/prompts               新建版本
POST   /config/prompts/:version/publish   发布
POST   /config/prompts/:version/rollback  回滚

GET    /users  POST /users  PATCH /users/:id  DELETE /users/:id
GET    /memories  PATCH /memories/:id  DELETE /memories/:id  POST /memories/:id/restore
GET    /tools  POST /tools  PATCH /tools/:id  DELETE /tools/:id  POST /tools/:id/test
GET    /tool-logs
GET    /observability/traces  /observability/traces/:id  /observability/cost  /observability/alerts/rules
GET    /evaluation/datasets  POST /evaluation/datasets  /evaluation/runs  /evaluation/compare
GET    /audit  /audit/actions
GET/POST/PATCH/DELETE /api/v1/admin/api-keys
```

### 租户前台 `/api/v1/customer`（customer JWT）

```
POST   /login   GET /me   POST /change-password
GET    /sessions  POST /sessions  GET /sessions/:id  PATCH /sessions/:id  DELETE /sessions/:id
PATCH  /sessions/:id/favorite                 收藏（不传 body = 切换）
GET    /sessions/:id/messages
POST   /sessions/:id/messages                  ★ 发消息（SSE 流式）
POST   /sessions/:id/tool-approvals            确认执行敏感工具
POST   /sessions/:id/tool-approvals/reject     取消
POST   /messages/:id/feedback                  👍👎
PATCH  /messages/:id/favorite                  消息级收藏
GET    /profile                                  租户名 + 首页欢迎语 + 推荐问题
GET    /documents                                知识库文档元信息
GET    /memories  POST /memories  PATCH /memories/:id  DELETE /memories/:id
DELETE /memories/permanent  /memories/:id/permanent   物理清空
```

### 对外接入 `/api/v1/public`（API Key）

```
GET    /search              read 档   只读检索（不调 LLM、不花钱）
POST   /chat                write 档  一次性 JSON 回答
POST   /chat/stream         write 档  SSE 流式
GET    /documents           admin 档  本租户知识库列表
DELETE /documents/:id       admin 档  删除文档
```

挂件（`/api/v1/public/widget/:tenantCode`）：`POST /sessions` · `GET /session` · `POST /messages` · `GET /info` · `POST /tool-approvals` · `POST /tool-approvals/reject`

### 平台方 `/api/v1/system`（system JWT，独立用户表）

```
POST /login  GET /me  POST /change-password
GET  /tenants  POST /tenants  GET /tenants/:id  PATCH /tenants/:id
PATCH /tenants/:id/status  PATCH /tenants/:id/expires_at
GET  /stats              跨租户 KPI（唯一返回跨租户数字的端点）
GET  /audit  /audit/actions   跨租户 + 含系统级日志
```

---

## 目录结构

```
ai-agent-forge/
├── src/                      后端（Koa + TypeScript）
│   ├── gateway/              四套子系统的路由 + 中间件
│   │   ├── admin/            租户后台
│   │   ├── customer/         租户前台
│   │   ├── public/           对外 API + 挂件
│   │   └── system/           平台方
│   ├── services/             业务逻辑（对话 / 记忆 / 评测 / 观测 / 成本 / 工具）
│   ├── rag/                  检索（切块 / 元素层 / 嵌入 / BM25 / 混合 / 重排）
│   │   └── elements/         结构解析（markdown AST / plaintext 启发式）
│   ├── tools/                工具（执行层 / 审批 / 委派 / http-mock）
│   │   └── builtin/          8 个内置工具实现
│   ├── agents/               多代理（引擎 / 子代理定义）
│   ├── workflows/            工作流（引擎 / 流程定义）
│   ├── models/               25 个 Sequelize 模型
│   ├── migrations/           37 个 Umzug 迁移
│   ├── lib/                  横切（鉴权 / 租户上下文 / 限流 / 熔断 / 重试 / 安全）
│   ├── prompts/              提示词拼装层
│   ├── config.ts             环境变量 schema（唯一真源）
│   └── server.ts             入口
├── web/                      前端（React + AntD）
│   ├── pages/                system / admin / customer / widget 四套页面
│   ├── layouts/              四套 Layout
│   ├── components/           公共组件（Markdown / Chart / TraceTimeline / …）
│   ├── lib/                  API 客户端
│   ├── theme.ts              深色模式 token
│   └── routes.tsx            路由表
├── shared/                   前后端共用（类型 / 提示词常量 / 校验）
├── docs/                     28 份主题文档（规格与代码 1:1）
├── scripts/                  migrate / sync-env / probe / smoke
├── tests/                    unit · integration · e2e
├── docker-compose.yml        MySQL + Qdrant
├── .env.example              环境变量模板
└── package.json
```

---

## 开发与测试

```bash
yarn dev              # 前后端一起起（后端自动跑迁移）
yarn typecheck        # 后端 + 前端 + e2e 三份 tsconfig 的类型检查
yarn test             # vitest 全部（unit + integration）
yarn test:unit        # 只跑单元测试
yarn test:integration # 只跑集成测试
yarn test:e2e         # Playwright（首次要先 npx playwright install chromium，约 100MB）
yarn lint             # ESLint
yarn format           # Prettier
```

- 集成测试和 e2e **跟 vitest 用同一个数据库**（`.env` 里那个），别拿生产库跑
- 改了 `src/models/` 里的字段 → 要跑 `yarn migrate` 让真实 MySQL 跟上
- 改了 `src/config.ts` 的 `envSchema` → 要跑 `yarn env:sync`，否则 `tests/unit/env-consistency.test.ts` 会红
- ⚠️ **`yarn lint` 目前跑不起来**：`typescript-eslint` 还不支持 TypeScript 7，ESLint 在加载配置阶段就退出了。**静态检查用 `yarn typecheck`**

有几条测试是「结构守卫」性质的 —— 它们机械核对代码和文档的一致性，改了代码忘改文档就会红：

| 测试 | 守什么 |
|---|---|
| `tests/unit/tenant-isolation-guard.test.ts` | 所有租户级查询都带租户过滤（白名单要写清理由） |
| `tests/unit/docs-consistency.test.ts` | 文档里的「内置工具 key 集合 / 配置项条数 / data part 类型」跟代码一致 |
| `tests/unit/e2e-route-coverage.test.ts` | e2e 的页面清单 ↔ `web/routes.tsx` 的路由表 |
| `tests/unit/env-consistency.test.ts` | `.env` / `.env.example` 的 key 集合 / 顺序 / 注释结构 |
| `tests/unit/antd-deprecated-props.test.ts` | 扫源码里 antd v6 已废弃的属性（组件不在页面上、抽屉没打开都算） |

---

## 已知限制

诚实列一下，README 里写清楚比让人踩坑强：

**架构层面**

- **BM25 是进程内内存索引** —— 单实例有效。多实例部署时各实例的关键词召回不一致（向量路始终一致）
- **限流、熔断都是进程内状态** —— 多实例部署时上限会放大到实例数倍
- **摘要 / 记忆抽取是 fire-and-forget** —— 进程在写完前被 kill 会丢这一段；没有跨实例的锁
- **trace 是结束时一次性写的** —— 进程在请求中途被 kill 会丢这一条 trace

**功能边界**

- **Word（.docx）解析不做** —— 只支持 PDF / Markdown / TXT
- **PDF 的标题只能靠启发式猜** —— PDF 的标题/版面信息在「抽成纯文本」那一步就丢了。猜错的代价是多一层面包屑，不丢内容
- **内置工具是 mock** —— 订单 / 商品 / 物流 / 优惠券都是按租户 + 编号确定性生成的假数据，不会进任何业务系统
- **`http` 工具是本地 mock** —— 平台不真的发请求。真出网要打到租户自己的服务器，出网策略还没定
- **MCP 不做** —— `tools.type` 的枚举值保留，端点层直接拒绝（400）
- **没有「转人工」** —— 本系统没有客服坐席角色，也没有「AI 答不上来」的判定机制
- **联网搜索不做** —— 要接外部搜索 API，平台方得买 key / 额度

**已知的产品行为变更**

- 租户后台登录页的「记住我」**默认不勾选** —— 不勾就存 sessionStorage，勾了才长期保留（以前默认勾选，等于默认把 token 在 localStorage 留 7 天）

---

## 文档索引

`docs/` 下 28 份主题文档。**文档和代码是 1:1 镜像关系**，改任何东西之前先看 [13-扩展指南.md §13.8 变更同步规则](./docs/13-扩展指南.md)。

| 文件 | 内容 |
|---|---|
| [01-需求与场景](./docs/01-需求与场景.md) | 业务场景、用户角色、三层登录、Out of Scope |
| [02-系统架构与目录](./docs/02-系统架构与目录.md) | 架构图、数据流、目录结构 |
| [03-a-技术栈-工程化规范](./docs/03-a-技术栈-工程化规范.md) | Node / TS / ESLint / Vitest / 错误处理 / 提交规范 |
| [03-b-技术栈-后端栈](./docs/03-b-技术栈-后端栈.md) | Koa / Vercel AI SDK / Sequelize / 四套子系统拆桶 |
| [03-c-技术栈-前端栈](./docs/03-c-技术栈-前端栈.md) | Vite / React / AntD / 路由 / 主题 |
| [04-a-ui-总则布局与菜单](./docs/04-a-ui-总则布局与菜单.md) | 设计总则 / 布局 / 菜单 / 命名约定 |
| [04-b-ui-登录与聊天挂件](./docs/04-b-ui-登录与聊天挂件.md) | 三个登录页 + 聊天挂件（流式 / 思考模式 / 反馈） |
| [04-c-ui-后台管理页面](./docs/04-c-ui-后台管理页面.md) | 租户后台所有页面 |
| [04-d-ui-系统级与公共组件](./docs/04-d-ui-系统级与公共组件.md) | 平台方页面 / 公共组件 / 路由清单 |
| [05-a-数据模型-mysql](./docs/05-a-数据模型-mysql.md) | MySQL 表 DDL + 索引 + 备份 + 迁移 |
| [05-b-数据模型-qdrant](./docs/05-b-数据模型-qdrant.md) | Qdrant Collection 设计 + 完整 RAG 数据流 |
| [06-大模型与Embedding](./docs/06-大模型与Embedding.md) | Anthropic 协议 / 各家模型 / Embedding / 密钥 |
| [07-a-模块-llm与prompt](./docs/07-a-模块-llm与prompt.md) | 模块 01-04：AI 基础 / LLM API / Prompt / Structured Output |
| [07-b-模块-工具与agent](./docs/07-b-模块-工具与agent.md) | 模块 05-07：Tool Calling / 多轮对话 / Agent 循环 |
| [07-c-模块-rag记忆状态协议](./docs/07-c-模块-rag记忆状态协议.md) | 模块 08-12：RAG / 记忆 / 状态工作流 / MCP |
| [07-d-模块-框架与多代理](./docs/07-d-模块-框架与多代理.md) | 模块 13-15：Agent 框架 / 多代理 / Browser Agent |
| [07-e-模块-评测观测可靠性](./docs/07-e-模块-评测观测可靠性.md) | 模块 17-19：评测 / Observability / 可靠性 + 成本 |
| [07-f-模块-安全与全栈](./docs/07-f-模块-安全与全栈.md) | 模块 20-23：AI Security / 后端基建 / 全栈产品化 |
| [08-评测方案](./docs/08-评测方案.md) | 评测集 + 四维 LLM-as-Judge + 流程 |
| [09-观测方案](./docs/09-观测方案.md) | 自建 trace + Pino + 告警 |
| [10-安全方案](./docs/10-安全方案.md) | 注入检测 / 内容审核 / 脱敏 / 鉴权 / 限流 |
| [11-部署运维与成本](./docs/11-部署运维与成本.md) | 本地启动 + 备份 + 故障排查 + 成本估算 |
| [12-a-需求-多租户与登录](./docs/12-a-需求-多租户与登录.md) | A 类：多租户基础 / 建租户 / 用户管理 / 三层登录 |
| [12-b-需求-ai对话能力](./docs/12-b-需求-ai对话能力.md) | B 类：多轮对话 / RAG / 记忆 / 工具 / 工作流 / 多代理 |
| [12-c-需求-管理员可配置](./docs/12-c-需求-管理员可配置.md) | C 类：知识库 / 提示词 / 模型 / 通用配置 |
| [12-d-需求-运维稳定](./docs/12-d-需求-运维稳定.md) | D 类：评测 / 观测 / 成本 / 安全 / 可靠性 |
| [12-e-需求-业务接入与平台运营](./docs/12-e-需求-业务接入与平台运营.md) | E + F 类 + 需求裁定表（哪些做 / 哪些不做） |
| [13-扩展指南](./docs/13-扩展指南.md) | 怎么往文档里加内容 + 模板 + 变更同步规则 |
| [AGENTS.md](./AGENTS.md) | 给 AI 工程师的简明操作手册 |

> **12-e 的裁定表是唯一权威落点** —— 「还有什么需求没做」这个问题直接看那张表，不要猜。

---

## License

MIT
