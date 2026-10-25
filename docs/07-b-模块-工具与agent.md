# 07-b · 模块 · 工具调用与 Agent（模块 05-07）

> **本文件是 `07-24模块知识点映射.md` 的模块 05-07**（原主文件已拆分为 07-a / 07-b / 07-c / 07-d / 07-e / 07-f 六份）。本份负责**Tool Calling + 多轮对话 + Agent 循环**（Vercel AI SDK 自动循环）。
> LLM 基础与 Prompt 见 `07-a-模块-llm与prompt.md`；RAG / 记忆 / 状态 / MCP 见 `07-c-模块-rag记忆状态协议.md`；框架与多代理见 `07-d-模块-框架与多代理.md`；评测 / 观测 / 可靠性见 `07-e-模块-评测观测可靠性.md`；安全与全栈见 `07-f-模块-安全与全栈.md`。

---

### 模块 05 · 工具调用（Tool Calling，通过 Vercel AI SDK）

**解决什么问题**：让 AI 能调外部函数（查订单 / 退款 / 查文档）。

**用到的技术**（**通过 Vercel AI SDK 间接使用**）：

- **Tool 定义协议**：`description` + **`inputSchema`**（Zod schema）+ `execute` 函数
  （⚠️ **字段名是 `inputSchema` 不是 `parameters`** —— `parameters` 是 AI SDK v1 的写法，
  已装的 v7 用 `inputSchema`；本项目 2026-10-25 落地 B3 时确认过）
- **自动工具循环**：Vercel AI SDK 的 `streamText({ tools: {...} })` 自动循环：模型说要工具 → 调 `execute` → 把结果回灌 → 继续生成
  （v5+ 的多步循环用 `stopWhen: stepCountIs(n)`，旧的 `maxSteps` 已移除；
  本项目的步数上限是 5 步，防模型反复调同一个工具把一次对话烧掉几十次 LLM 调用）
- **多工具并行**：模型可以一次调多个工具，SDK 自动并发
- **可选强制工具**：`toolChoice: 'required'`（要求必须调工具）或 `'tool:xxx'`（指定调哪个）—— 由开发者按需选用，不写死
- **MCP 集成**：MCP 服务作为工具的 `execute` 内部实现（**本轮未做**）

**当前状态**：✅ **已落地**（2026-10-25，B3 工具调用 + C2 工具管理）。
本轮做的是**平台内置的 mock 工具函数**（`src/tools/builtin/`，5 个），
`http` / `mcp` 两类未开放 —— 见 [12-b §B3](./12-b-需求-ai对话能力.md)。

**选型理由**：Vercel AI SDK 的 `tool()` helper 是最简洁的；自带 Zod 校验 + 自动循环；手写循环留作 Vercel AI SDK 不支持的场景。

---

### 模块 06 · 多轮对话与上下文管理

**解决什么问题**：让 Agent 能记住对话历史，但不能超出上下文窗口。

**用到的技术**：

- 对话历史滑动窗口（保留最近 N 轮）
- 摘要压缩（Summarization）：超长对话自动压缩早期内容
- Token 预算（Token Budget）：给系统提示、对话历史、检索结果、工具结果各分配配额
- 系统提示缓存（Prompt Caching）省成本（Anthropic 支持）

**关键代码**：

**怎么用**：

- 每条请求构造 context 时，按预算填，超出按优先级裁剪：先压历史、再砍检索
- 监控 context utilization，超过 80% 告警

---

### 模块 07 · Agent 循环（**用 Vercel AI SDK 自动循环，不手写**）

**解决什么问题**：让 AI 能多步执行（调工具 → 看结果 → 决定下一步 → ...）。**本项目**不手写循环，直接用 Vercel AI SDK 的自动循环。

> **重要变化**：之前文档有「while 循环 + 步骤计数器 + stop_reason 判断 + 工具结果回灌」的完整手写示例。**本项目**改用 Vercel AI SDK，**代码不用手写**，但**概念必须懂**（因为这是 AI 系统的核心机制）。

**必须懂的概念**（即使代码不手写）：

| 概念             | 说明                                                                      |
| ---------------- | ------------------------------------------------------------------------- |
| **while 循环**   | 反复调 LLM，直到模型说「够了」                                            |
| **stop_reason**  | `end_turn`（生成完了）vs `tool_use`（要调工具）vs `max_tokens`（截断）    |
| **工具结果回灌** | 工具执行完，把结果作为 `role: 'tool'` 的消息塞回 messages，模型看结果继续 |
| **最大步数限制** | 防止死循环（典型 10 步）                                                  |
| **总超时**       | 防止长时间挂起（典型 30 秒）                                              |
| **多工具并发**   | 一次响应里多个 `tool_use`，并发执行                                       |

**代码：用 Vercel AI SDK 自动循环**（**5 行替代之前的 50+ 行**）：

**什么时候要手写循环**（Vercel AI SDK 不支持的场景）：

- 复杂的 context 压缩（每步结束后手动 summarization）
- 工具调用之间的状态共享（用 `experimental_streamData`）
- 多代理 / 嵌套工具

这种时候直接调 `@anthropic-ai/sdk`：

**选型理由**：Vercel AI SDK 处理 99% 场景；剩 1% 直接调 Anthropic SDK 手写。

---
