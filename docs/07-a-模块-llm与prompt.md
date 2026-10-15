# 07-a · 模块 · LLM 基础与 Prompt（模块 01-04）

> **本文件是 `07-24模块知识点映射.md` 的模块 01-04**（原主文件已拆分为 07-a / 07-b / 07-c / 07-d / 07-e / 07-f 六份）。本份负责**AI 基础认知 + LLM API + Prompt Engineering + Structured Output**。
> 工具与 Agent 循环见 `07-b-模块-工具与agent.md`；RAG / 记忆 / 状态 / MCP 见 `07-c-模块-rag记忆状态协议.md`；框架与多代理见 `07-d-模块-框架与多代理.md`；评测 / 观测 / 可靠性见 `07-e-模块-评测观测可靠性.md`；安全与全栈见 `07-f-模块-安全与全栈.md`。

> 这一节是文档的核心。每个模块讲四件事：
> ① 它在本项目里解决什么问题 ② 用到的库 / 框架 / 算法 ③ 关键代码示例 ④ 选型理由 + 怎么用
>
> 工程化规范（Node / TypeScript / ESLint / Prettier / Husky 等）见 `03-a-技术栈-工程化规范.md`。

---

### 模块 01 · AI 与大模型基础认知

**解决什么问题**：开发团队对大模型的能力边界有一致认知，知道什么时候用大模型、什么时候用规则。

**用到的概念**（在项目里要写进 wiki / ADR）：

- Token（词元）：计费单位 + 上下文窗口限制单位
- 上下文窗口（Context Window）：对话历史的最大长度
- 温度（Temperature）：控制输出的随机性
- 系统提示（System Prompt）：定义模型角色与规则
- 幻觉（Hallucination）：模型生成看似合理但实际错误的内容

**怎么用**：

- 在 `/docs/wiki/AI.md` 写一份团队 wiki，把这些概念说清
- 每个 PR 里涉及大模型的部分，必须引用 wiki 里的对应概念
- 代码里所有 prompt 长度、上下文长度都要写注释 + 监控

---

### 模块 02 · LLM API 开发（通过 Vercel AI SDK）

**解决什么问题**：让应用能稳定调 LLM API；处理流式 / 工具 / 多模态 / 缓存。

**用到的技术**（**通过 Vercel AI SDK 间接使用**）：

- Messages API 协议（`{ role, content }`）
- 流式输出（`streamText()`）
- Tool Use（`tools: { name: tool({...}) }`）
- Prompt Caching（`cacheControl` 透传）
- 多模态（图片 / 文件理解）
- 错误码 + 重试（SDK 内置）

**关键代码**：

**高级场景（直接 `@anthropic-ai/sdk`）**：精细控制缓存 / 多模态原始格式 / Beta 能力。

---

### 模块 03 · 提示词工程（Prompt Engineering）

**解决什么问题**：让大模型的输出稳定、可控、可复现。

**用到的技术**：

- 系统提示设计（角色 + 规则 + 输出格式 + 限制）
- 少样本提示（Few-shot Prompting）：给 2-3 个例子让模型学
- 思维链（Chain of Thought, CoT）：让模型「一步步想」
- 提示词版本管理（每次修改都版本化、可回滚）
- 提示词测试（用评测集验证 prompt 改动的效果）

**关键代码**：

**选型理由**：把 prompt 抽成文件、版本号（`v3`）走 git 管理，每次改动走评测验证。

**怎么用**：

- 每次发版前用评测集跑一遍，确保 prompt 改动没让效果变差
- prompt 文件改动要在 PR 里特别标注，让 reviewer 重点看

---

### 模块 04 · 结构化输出（Structured Output）

**解决什么问题**：让大模型输出可被代码直接消费的 JSON，而不是需要二次解析的文本。

**用到的技术**：

- JSON Schema 约束输出格式
- 工具调用（Tool Calling）天然就是结构化的
- Zod 验证：模型输出后用 Zod 验证 schema 再用
- **Vercel AI SDK 的 `generateObject()` / `output: 'structured'`** —— 自动重试 + 自动校验 + 自动重解析

**关键代码 1：Vercel AI SDK 的 `generateObject()`**：

**关键代码 2：流式 + 结构化**（`streamText` + `output: 'structured'`）：

**关键代码 3：手写 Zod 校验（兜底）**：

**选型理由**：Vercel AI SDK 的 `generateObject` + Zod schema 是最简洁的；手写 parse 留作高级 / 兜底场景。

---
