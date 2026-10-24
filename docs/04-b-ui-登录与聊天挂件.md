# 04-b · UI 需求 · 登录与聊天挂件

> **本文件是 `04-UI需求.md` 的 §3-§4 节**（原主文件已拆分为 04-a / 04-b / 04-c / 04-d 四份）。本份负责**3 个登录页 + 聊天挂件（含流式聊天 / 思考模式 / 反馈 / 文件上传）**。
> 设计总则 / 布局 / 菜单见 `04-a-ui-总则布局与菜单.md`；后台管理页面见 `04-c-ui-后台管理页面.md`；系统级与公共组件见 `04-d-ui-系统级与公共组件.md`。

---

## 3. 登录页面（3 个）

> **所有登录页都遵循**：全屏居中卡片 + 居中 logo + 标题 + 表单 + 按钮。
> 三个登录页用不同路由 + 相似布局 + 不同文案。

### 3.1 系统级登录 `/system/login`

| 字段           | 必填 | 校验     |
| -------------- | ---- | -------- |
| 邮箱           | ✓    | 邮箱格式 |
| 密码           | ✓    | ≥ 8 字符 |
| 验证码（可选） | —    | —        |

- 提交：`POST /api/v1/system/login`
- 成功 → 跳 `/system`
- 失败：`401 邮箱或密码错误`（不泄露用户是否存在）
- 「**没有 SaaS 平台方账号？联系系统部署方**」提示文案

### 3.2 租户后台登录 `/admin/login`

| 字段       | 必填 | 校验                     |
| ---------- | ---- | ------------------------ |
| **租户号** | ✓    | `[a-z0-9-]{3,32}`        |
| 邮箱       | ✓    | 邮箱格式                 |
| 密码       | ✓    | ≥ 1 字符                 |
| 「记住我」 | —    | localStorage 存 JWT 7 天 |

- 提交：`POST /api/v1/admin/login`（admin 角色）
- 成功 → 跳 `/admin/dashboard`（若 `must_change_password=true` 强制跳改密页）
- 失败：`401 邮箱或密码错误`
- 「**租户号由你的 SaaS 服务方提供**」副文案
- 「**租户号格式**：3-32 位小写字母 / 数字 / 短横线（例：acme-corp）」

### 3.3 前台用户登录 `/customer/login`

| 字段       | 必填 | 校验     |
| ---------- | ---- | -------- |
| **租户号** | ✓    | 同上     |
| 邮箱       | ✓    | 邮箱格式 |
| 密码       | ✓    | ≥ 1 字符 |

- 提交：`POST /api/v1/customer/login`（customer 角色）
- 成功 → 跳 `/customer/chat`（或默认页）
- 「**没有账号？联系你的租户管理员**」副文案

### 3.4 公共部分

- 卡片宽度：400px
- 顶部：公司 Logo（占位用 AntD `RobotOutlined` 蓝色背景圆 + 文字「AI」）
- 标题：「登录到 AI 助手」
- 副标题：根据登录类型变化文案
- 输入框：标准 AntD `<Input />` + `<Input.Password />`
- 登录按钮：`<Button type="primary" block>登录</Button>`
- 「忘记密码」（v1 不实现，UI 留位 + 灰色禁用 + 提示「请联系管理员」）

---

## 4. 聊天挂件（P1 · 重点）

> **这是产品最核心的 UI**，要做得精。
>
> **状态（2026-10-24）**：§4 的**对话能力**部分已落地，实现在
> `web/pages/customer/ChatPage.tsx` + `src/gateway/customer/chat-routes.ts`，
> 入口是 `/customer` 与 `/customer/chat`（**需要登录**，customer 角色）。
>
> **公开挂件也已落地**（E1，2026-10-24）：`/widget/:tenantCode`（**免登录**），
> 实现在 `web/pages/widget/WidgetPage.tsx` + `src/gateway/public/widget-routes.ts`。
> 匿名会话靠一枚签名 token（`X-Widget-Token` 头）认领，完整设计见
> [12-e](./12-e-需求-业务接入与平台运营.md) §E1。
>
> 本节里标 ⏳ 的仍然没做：附件 / 图片上传、联网开关、**收藏**、点踩的原因弹窗。

### 4.1 整体布局

```
┌────────────────────────────────────────────────────┐
│ 🏢 Acme 公司客服 · 在线                  ×  │ ← Header (40px)
├──────┬─────────────────────────────────────────────┤
│      │                                             │
│ 历史 │  消息列表                                    │
│ 会话 │  ┌─────────────────────────────────┐        │
│      │  │  👤 你好，请问年假怎么算？         │        │
│      │  └─────────────────────────────────┘        │
│      │                                             │
│ +新对 │  ┌─────────────────────────────────┐        │
│ 话   │  │  🤖 根据公司政策，年假按以下规则：  │        │
│      │  │     1. 5 天年假 ...               │        │
│ -会话1 │  │     2. 病假 ...                 │        │
│ -会话2 │  │  来源：《员工手册 v3》第 12 页   │ ← 引用卡片
│      │  │  [查看原文]                      │        │
│      │  │  ☐ 思考模式 ✓   ☐ 联网   📎附件  │        │
│      │  │  ┌──── 输入框 ──────────┐  [发送]│        │
│      │  └─────────────────────────────────┘        │
│      │                                             │
└──────┴─────────────────────────────────────────────┘
```

### 4.2 消息气泡

#### 用户消息

- 右对齐，**主题色 `colorPrimary`（`#2f54eb`）**背景，白字
  > 2026-10-21 校正：原规格写死 AntD 默认蓝 `#1677ff`，但本项目 `web/theme.ts` 的
  > `colorPrimary` 是刻意选的极客蓝 `#2f54eb`，**theme 才是真理来源**，气泡跟主题走。
- 圆角 12px（左下 4px，其他 12px）
- 文本 + 图片缩略图（点开看大图）
- 右上角小时间戳（hover 显示完整时间）

#### AI 消息

- 左对齐，浅灰背景 `#f5f7fa`（`colorBgLayout`），深字
- 圆角 12px（右下 4px，其他 12px）
- 内容：Markdown 渲染（含 GFM 表格 / 任务列表 / 代码高亮）
- 附件缩略图（**例外**：用户上传的内容不是 UI 装饰）：图片用 `<img>`，PDF / Word 用对应 AntD 文件图标（`<FilePdfOutlined />` 等）+ 文件名
- **思考模式**：上半部分可折叠 `<details>` 「💭 思考过程」（默认折叠）
- **引用片段卡片**：气泡上方的文档名 + 段号 + 相关度 + 召回标签（语义 / 关键词），
  正文可展开全文（≤3 行，`ellipsis={{ rows: 3, expandable: true }}`）
- 工具调用：工具名 + 输入输出（`<Collapse>` 折叠）
- 操作行：👍 / 👎 / 复制 / 🔄 重新生成 / 📌 收藏

### 4.3 输入区

| 元素              | 行为                                                             |
| ----------------- | ---------------------------------------------------------------- |
| 文本框            | `<Input.TextArea autoSize>`；按 `Enter` 发送；`Shift+Enter` 换行 |
| 发送按钮          | 文本空时 disabled；发送中显示 loading；发送后清空                |
| 📎 附件按钮       | 点击 → 弹窗（图片 / 文件 / 音频 三选）                           |
| 🎤 语音按钮       | 暂不实现（v1 UI 留位）                                           |
| 输入框上方 toggle | 「思考模式」开关、「联网」开关（v1 占位）                        |

### 4.4 思考模式（核心功能）

> 「思考模式」= AI 显示推理过程，**不直接给答案**。

**UI 表现**：

- 输入框上方有「☐ 思考模式」开关
- 开启后，AI 回复**先**显示思考（折叠收起，默认收起）
- 用户点开看到完整推理过程
- 然后才是最终答案

**消息渲染示例**：

```
┌─────────────────────────────────────┐
│  🤖                                  │
│  ▼ 💭 思考过程                        │ ← Collapse (展开 / 收起)
│    用户问的是年假政策，需要：           │
│    1. 检索"年假"相关文档              │
│    2. 提取具体规则                    │
│    3. 按工龄分类整理                   │
│  ─────────────────────────────────   │
│  根据公司《员工手册 v3》第 12 页：       │
│     1. 5 天年假（满 1 年）              │
│     2. 10 天年假（满 5 年）             │
│  来源：员工手册 v3 / 第 12 页          │
│  [查看原文]                            │
│                          👍 👎 复制 📌  │
└─────────────────────────────────────┘
```

### 4.5 图像理解 + 图像生成

#### 4.5.1 图像理解（v1 实现）

- 用户点 📎 选「图片」→ 上传 → **图片缩略图**插入到输入框（**缩略图例外**：用户上传的内容是真内容，不是 UI 装饰）
- 发送后：用户气泡显示图片缩略图 + 文字
- AI 收到图片后能识别内容（依赖底层大模型支持视觉，如 Claude Sonnet 支持图片）
- 上传前显示：「📎 待发送：image.png [× 删除]」（缩略图 + AntD `<CloseOutlined />` 删除按钮）

#### 4.5.2 图像生成（v1 占位 / Phase 2 实现）

- 输入框上方有「🎨 图像生成」开关（v1 UI 留位，灰显 + tooltip「即将推出」）
- 开启后：输入框变成 prompt 框；点发送 → 等待 → 弹出图片
- 后端接 DALL-E / Stable Diffusion / 智谱 CogView

> **图像生成结果例外**：用 AntD `<Image.PreviewGroup>` 展示生成的图，支持点击放大。生成进度用 AntD `<Progress />` + `<Spin />`，不用自定义图片。

### 4.6 文件上传（PDF / Word / TXT）

- 点 📎 → 选「文件」→ 上传到当前租户的知识库
- 进度条 + 上传后自动开始索引
- 索引完自动滚到消息：「文档已添加到知识库」
- **说明**：文件其实是先存到知识库，再让 AI「读」这个文件回答问题

### 4.7 历史会话

- 左侧抽屉 / 可隐藏侧栏
- 列表：每条会话显示「首条消息前 20 字」+ 「最后消息时间」+ 「未读小红点」
- 操作：点开 / 改名 / 删 / 收藏（⭐）
- 顶部：「+ 新对话」按钮

### 4.8 反馈 ✅ 已落地（2026-10-21）

- AI 消息底部：👍 / 👎 按钮（再点一次取消，`feedback = null`）
- 点赞：写 `messages.feedback = 1` + `feedback_at`
- 点踩：写 `-1`；**「答错 / 答偏 / 有害 / 其他」的选择弹窗本期没做**，
  只支持可选的 `feedback_text`（后端字段和端点都留好了）
- 后端：`POST /api/v1/customer/messages/:id/feedback`
  （原规格写的 `/api/v1/sessions/:id/feedback` 不对——反馈挂在**消息**上，不是会话上；
  且路径要带 `customer` 前缀，前缀约定见 `03-b` §B.5.2）

### 4.9 特殊元素

- **代码块**：highlight.js 渲染 + 复制按钮（右上角）
- **表格**：Markdown 表格 → HTML 表格
- **引用块**：左侧蓝色边 + 浅灰背景
- **链接**：自动识别 + 新窗口打开

### 4.10 流式聊天实现（关键 · 用 Vercel AI SDK）

> 「流式」= AI 边生成边返回，UI 边收边显示，**不等全部生成完**。这是聊天产品的核心体验。

#### 4.10.1 用了什么库

| 端              | 用什么                                                                               | 作用                                       |
| --------------- | ------------------------------------------------------------------------------------ | ------------------------------------------ |
| **后端**        | **`ai`**（Vercel AI SDK 核心）+ **`@ai-sdk/anthropic`**（Anthropic provider 适配器） | `streamText()` 一句拿流式 token + 工具调用 |
| **后端 → 前端** | **SSE**（Server-Sent Events）                                                        | Vercel AI SDK 自动转 SSE 格式              |
| **前端**        | **`@ai-sdk/react`** 的 **`useChat()` hook**                                          | 1 行接 SSE、自动状态管理、自动重连         |

> **关键决策**：用 Vercel AI SDK 是因为它**比直接调 Anthropic SDK 更简单**（5 行 vs 30 行），且跟前端 `useChat()` 无缝对接。

#### 4.10.2 数据流

```
[前端] 用户点发送
   │
   │ const { append } = useChat() → fetch('/api/chat')
   ▼
[后端 Koa]  ctx.body = streamText({...}).toDataStreamResponse()
   │
   │ Vercel AI SDK 自动调 Anthropic SDK
   ▼
[@ai-sdk/anthropic]  streamText 边生成边返回
   │
   │ Vercel AI SDK 自动转 SSE
   ▼
[SSE 响应]  "0:" + JSON({type:'text', delta}) + "\n" + ...
   │
   │ useChat() 解析
   ▼
[前端 React state]  messages 数组更新
   │
   ▼
[用户屏幕]  看到 AI 逐字出现
```

#### 4.10.3 后端关键代码（**5 行**）

**对比之前**：30 行（手写 Anthropic SDK 调用 + SSE 响应头 + event 循环）。**现在 5 行**。

#### 4.10.4 前端关键代码（**1 hook**）

**对比之前**：40 行（手写 SSE parser + 状态管理 + AbortController）。**现在 1 hook**。

#### 4.10.5 UI 上的流式表现

| 状态         | UI                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------ |
| 用户点发送   | 立即看到「✍ 思考中...」+ AntD `<Spin />`                                                  |
| 流式回包中   | AI 气泡从「**空**」到「**逐字出现**`（由 useChat 自动维护 messages 数组触发 React 重渲染） |
| 流式结束     | 完整气泡出现 + 「👍 👎 复制」操作行                                                        |
| 用户中途取消 | 「停止」按钮 → `stop()` → abort signal → 后端关闭流                                        |

#### 4.10.6 用了 Vercel AI SDK 还省了哪些事

| 原本要做的                                             | Vercel AI SDK 自带                                       |
| ------------------------------------------------------ | -------------------------------------------------------- |
| 写 SSE 响应头（`Content-Type: text/event-stream` 等）  | `toDataStreamResponse()` 自动加                          |
| 手写 SSE 事件格式（`event: text\ndata: ...\n\n`）      | 自动                                                     |
| 解析 SSE 流（split by `\n\n` + 解析 `event:` `data:`） | `useChat()` 自动                                         |
| AbortController 取消流式                               | `useChat()` 的 `stop()` 函数                             |
| 重连机制                                               | `useChat()` 自动重连                                     |
| 工具调用协议（function calling → 工具执行 → 结果回灌） | `tool({...})` helper + `streamText` 自动循环             |
| Structured Output（Zod 校验 + 解析）                   | `generateObject()` + `output: 'structured'`              |
| 流式 token 计数 + 成本统计                             | `result.usage`（含 `promptTokens` / `completionTokens`） |

#### 4.10.7 库依赖清单（确认有 Vercel AI SDK）

> ⚠️ 这份清单在 2026-10-21 B1 落地时**校正过**：原文档写的是 ai v5 / `@ai-sdk/*` v1，
> 实际装的是 ai v7 + `@ai-sdk/*` v4（API 形态完全不同，下面是现装版本）。

```json
// package.json（前后端共用这一个）
{
  "dependencies": {
    "ai": "^7.0.140",                  // ← Vercel AI SDK 核心（streamText / createUIMessageStream）
    "@ai-sdk/anthropic": "^4.0.79",   // ← Anthropic provider（createAnthropic 工厂）
    "@ai-sdk/react": "^4.0.143",      // ← useChat hook
    "@anthropic-ai/sdk": "^0.134.0"   // ← ai-sdk 的传递依赖；高级场景可直接调
  }
}
```

> v4 的 `useChat` 用 `transport` 而不是 `api`：
> `new DefaultChatTransport({ api, headers })`。**`headers` 必须手动带 Authorization**
> —— `useChat` 内部走 `fetch`，完全绕过 `web/lib/apiShared.ts` 的 axios 拦截器，忘了带就是一路 401。
>
> 前端从 `'ai'` 直接 import `DefaultChatTransport`（v7 已 hoist 到顶层，前后端同一个实例）。
> 原 `vite.config.ts` 里那个指向 `node_modules/@ai-sdk/react/node_modules/ai` 的
> `@ai-sdk-internal` alias **指向的目录不存在**（yarn 把 ai 提升到了顶层），
> 已在 B1 一并删掉——留着只会让下一个人 import 到解析失败。

#### 4.10.8 Koa 下的 SSE 桥接（关键 · 别自己重写一遍）

`createUIMessageStreamResponse()` 返回的是 **web 标准 `Response`**，塞进 Koa 要额外转换。
用 AI SDK 自己给 Node handler 准备的 helper 更省事：

```ts
import { createUIMessageStream, pipeUIMessageStreamToResponse } from 'ai';

ctx.respond = false; // @types/koa 明确支持：绕过 Koa 响应处理
await pipeUIMessageStreamToResponse({
  response: ctx.res,   // Koa 的 ctx.res 就是 Node ServerResponse
  status: 200,
  stream,
  keepAliveMs: 15_000,  // 开流即发 `: stream-open`，之后按间隔发 `: keep-alive`
});
```

三个必须知道的点：

1. **SSE 响应头不用自己写**。SDK 会 merge 进来 `content-type: text/event-stream`、
   `cache-control: no-cache`、`connection: keep-alive`、`x-accel-buffering: no`
   （关 nginx 缓冲）、`x-vercel-ai-ui-message-stream: v1`。重复设反而可能冲突。
2. **`await` 必须写**。`ctx.respond = false` 之后 Koa 不再负责收尾，不等它响应就永远挂死。
3. **backpressure / flush / 客户端断连取消**，`writeToServerResponse` 内部全处理了
   （`response.once('close')` → `reader.cancel()` 一路 cancel 到 `streamText` 的 fetch），
   所以断连时 `onEnd` 照样触发，消息状态记 `cancelled` 且保留已生成的部分正文。

#### 4.10.9 ⚠️ 流式端点的错误时机分界线（最容易踩的坑）

`src/gateway/error-handler.ts` 只能靠 `ctx.status` / `ctx.body` 改响应。
**`pipeUIMessageStreamToResponse` 一调 `response.writeHead(200)`，响应就锁死了**，
之后再 throw 只会得到一个坏掉的流。所以：

```
ctx.respond = false 之前（还能正常返 4xx / 5xx）
  · 入参 zod 校验
  · 会话归属校验（跨租户 / 跨用户 → 404）
  · LLM 凭据校验（缺 key 要在这里报出来，否则用户只看到一个空流）
  · 落库 user 行 / assistant 占位行
  · 历史查询（DB 挂了还能返 500）
ctx.respond = false 之后（只能走流内 error）
  · 真正的 LLM 网络请求、检索、结果解析、落库回填
```

流内的错误统一走 `createUIMessageStream({ onError })` → 变成 `{type:'error', errorText}` chunk。
**`onError` 绝不能把 `err.message` 直接返回**（泄漏内部细节），返回固定中文文案，
细节只进 `logger.error`。

### 4.11 我的记忆 `/customer/memories` ✅ 已落地 2026-10-24

用户看自己被 AI 记住的信息，并决定要不要让 AI 记。对应 B4，
接口见 [12-b](./12-b-需求-ai对话能力.md) §B4。

```
┌──────────────────────────────────────────────────────────────┐
│  我的记忆                              [刷新]  [+ 添加记忆]     │
│  AI 记住的关于你的信息。可以随时查看、改掉，或者干脆不让它记。   │
│                                                               │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │ 自动记忆                                          [ ●──]  │ │
│  │ 开启后，AI 会从对话里自动记住你提到的偏好和情况…           │ │
│  │ 关掉后既不会自动记，也不会把已有的记忆带进回答。           │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                               │
│  [生效中▾]  [清空全部]  彻底删除全部                              │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │ 内容              │分类│来源│被引用│更新时间│操作         │ │
│  │ 回答请用中文，尽量简短│偏好│自写│ 3 次│2026-10-24│编辑 删除│ │
│  └──────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

- **自动记忆开关**：整个页面的核心。一个开关同时管住「不再自动记」和「不再往回答里塞」。
  不想被记就关掉 —— 这是隐私控制，不是「关闭某个小功能」
- **「添加记忆」**：用户自己写一条（`source='user'`）。
  自动抽取**不许改、不许归档**用户自己写的记忆 —— 用户明确表达过的比模型猜的更权威
- **「编辑」**：改内容 + 分类。改完下一轮对话立即生效
- **「删除」**：软删（归档），删错了可以在「已删除」筛选里恢复
- **「清空全部」**：所有记忆条目归档，AI 将不再记得关于你的任何信息（**可恢复**）
- **「彻底删除全部」**：物理删，**不可恢复**。用户行使「删除我的全部个人数据」的权利时
  用这个（归档只是软删，数据还在库里）。用 Modal 二次确认，话术要说清「不可恢复」
- **已归档的行多一个「彻底删除」**：单条物理删（`DELETE /memories/:id/permanent`），
  同样不可恢复
- **状态筛选**：生效中 / 已删除 / 全部
- **分类配色**：画像紫 / 偏好蓝 / 事实绿 / 情境橙（跟租户后台的「用户记忆」页一致）

**入口**：前台侧栏「我的记忆」（`/customer/memories`），紧挨着「智能问答」。

---

