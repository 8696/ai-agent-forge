# 08-b · 模块 · 工具调用与 Agent（模块 05-07）

> **本文件是 `08-24模块知识点映射.md` 的模块 05-07**（原主文件已拆分为 08-a / 08-b / 08-c / 08-d / 08-e / 08-f 六份）。本份负责**Tool Calling + 多轮对话 + Agent 循环**（Vercel AI SDK 自动循环）。
> LLM 基础与 Prompt 见 `08-a-模块-llm与prompt.md`；RAG / 记忆 / 状态 / MCP 见 `08-c-模块-rag记忆状态协议.md`；框架与多代理见 `08-d-模块-框架与多代理.md`；评测 / 观测 / 可靠性见 `08-e-模块-评测观测可靠性.md`；安全与全栈见 `08-f-模块-安全与全栈.md`。

---

### 模块 05 · 工具调用（Tool Calling，通过 Vercel AI SDK）

**解决什么问题**：让 AI 能调外部函数（查订单 / 退款 / 查文档）；本项目当前 scope 不做，但 MCP + 工具调用是 AI 系统的关键能力，**设计稿保留**。

**用到的技术**（**通过 Vercel AI SDK 间接使用**）：

- **Tool 定义协议**：`name` + `description` + `parameters`（Zod schema）+ `execute` 函数
- **自动工具循环**：Vercel AI SDK 的 `streamText({ tools: {...} })` 自动循环：模型说要工具 → 调 `execute` → 把结果回灌 → 继续生成
- **多工具并行**：模型可以一次调多个工具，SDK 自动并发
- **强制工具调用**：`toolChoice: 'required'`（要求必须调工具）或 `'tool:xxx'`（指定调哪个）
- **MCP 集成**：MCP 服务作为工具的 `execute` 内部实现

**关键代码 1：用 SDK 的 `tool()` helper 定义**：

```typescript
import { tool } from 'ai';
import { z } from 'zod';

// 定义工具
export const orderQueryTool = tool({
  description: '查询用户的订单。按订单 ID 或按时间范围。',
  parameters: z.object({
    order_id: z.string().optional(),
    user_id: z.string().optional(),
    since: z.string().datetime().optional(),
  }),
  execute: async ({ order_id, user_id, since }) => {
    // 这里调 MCP 客户端或直接调业务 API
    return await mcpClient.callTool('order_query', { order_id, user_id, since });
  },
});

// 挂到 streamText
const result = streamText({
  model: anthropic('claude-sonnet-4-5'),
  system: systemPrompt,
  messages,
  tools: { order_query: orderQueryTool },
});
```

**关键代码 2：强制工具 + 多工具**：

```typescript
const result = streamText({
  model: anthropic('claude-sonnet-4-5'),
  messages,
  tools: { order_query, refund_apply, ticket_create },
  toolChoice: 'auto', // 'auto' | 'required' | 'tool:<name>'
});
```

**关键代码 3：手写工具循环**（Vercel AI SDK 暂不支持的场景才用）：

```typescript
// 直接调 Anthropic SDK，自己管理 tool_use 循环
let messages = [{ role: 'user', content: '查一下订单' }];
for (let i = 0; i < 5; i++) {
  const response = await anthropic.messages.create({ model, messages, tools });
  if (response.stop_reason === 'end_turn') break;

  // 处理 tool_use
  const toolResults = await Promise.all(
    response.content.filter((b) => b.type === 'tool_use').map((b) => executeTool(b.name, b.input)),
  );
  messages.push({ role: 'assistant', content: response.content });
  messages.push({ role: 'user', content: toolResults });
}
```

**当前 scope 不实现**（外部业务系统需要另外的项目）；**Phase 2 接入 MCP 服务时直接用 SDK 的 `tools: {...}` 模式**。

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

```typescript
// shared/context/budget-manager.ts
export interface ContextBudget {
  system: number; // 系统提示词预算（Token 数）
  retrieval: number; // 检索结果预算
  history: number; // 对话历史预算
  tools: number; // 工具结果预算
  output: number; // 给模型输出的预留
}

export const DEFAULT_BUDGET: ContextBudget = {
  system: 2000,
  retrieval: 3000,
  history: 8000,
  tools: 2000,
  output: 1000,
};

// 用 Anthropic 的 prompt caching 把 system + 检索结果缓存
// 每条消息的 token 计入预算，超出就压缩或裁剪
```

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

```typescript
import { streamText, tool } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';

// 定义工具（详见模块 05）
const orderQueryTool = tool({
  description: '查询订单',
  parameters: z.object({ order_id: z.string() }),
  execute: async ({ order_id }) => {
    return await mcpClient.callTool('order_query', { order_id });
  }
});

// 一次调用，SDK 自动处理全部循环
const result = streamText({
  model: anthropic('claude-sonnet-4-5'),
  system: systemPrompt,
  messages,
  tools: { order_query: orderQueryTool }
  // SDK 内部自动：
  //   1. 调模型 → 拿到 tool_use → 调 execute
  //   2. 把结果回灌 messages → 再调模型
  //   3. 直到 stop_reason === 'end_turn'
});

// 想限制步数 / 超时？
const result = streamText({
  model: anthropic('claude-sonnet-4-5'),
  messages,
  tools: {...},
  maxSteps: 10,                   // 最多 10 步
  abortSignal: AbortSignal.timeout(30_000)  // 30 秒超时
});
```

**什么时候要手写循环**（Vercel AI SDK 不支持的场景）：

- 复杂的 context 压缩（每步结束后手动 summarization）
- 工具调用之间的状态共享（用 `experimental_streamData`）
- 多代理 / 嵌套工具

这种时候直接调 `@anthropic-ai/sdk`：

```typescript
let messages = [...];
for (let step = 0; step < 10; step++) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    messages
  });
  if (response.stop_reason === 'end_turn') break;

  // 手动处理 tool_use
  const toolResults = await Promise.all(
    response.content
      .filter(b => b.type === 'tool_use')
      .map(b => executeTool(b.name, b.input))
  );
  messages.push({ role: 'assistant', content: response.content });
  messages.push({ role: 'user', content: toolResults.map((r, i) => ({
    type: 'tool_result',
    tool_use_id: response.content.filter(b => b.type === 'tool_use')[i].id,
    content: JSON.stringify(r)
  })) });
}
```

**选型理由**：Vercel AI SDK 处理 99% 场景；剩 1% 直接调 Anthropic SDK 手写。

---
