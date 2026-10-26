# 04-d · UI 需求 · 系统级页面、公共组件与扩展

> **本文件是 `04-UI需求.md` 的 §6-§13 节**（原主文件已拆分为 04-a / 04-b / 04-c / 04-d 四份）。本份负责**SaaS 平台方页面 / 公共组件 / 交互模式 / 主题 / 扩展点 / 验收 / 路由清单 / 与其他文档的关系**。
> 设计总则 / 布局 / 菜单见 `04-a-ui-总则布局与菜单.md`；登录与聊天挂件见 `04-b-ui-登录与聊天挂件.md`；后台管理页面见 `04-c-ui-后台管理页面.md`。

---

## 6. 系统级页面（SaaS 平台方）

### 6.1 租户列表 `/system/tenants`

```
┌────────────────────────────────────────────────────────────────┐
│  租户管理                                  [+ 创建租户]          │
│                                                                  │
│  [搜索框]  [套餐筛选]  [状态筛选 active/disabled]                │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │ ☐ │ 租户号     │ 名称 │ 套餐 │ 状态      │ 到期时间      │ 用户数 │ 创建时间   │ 操作              │ │
│  │ ☐ │ acme-corp  │ Acme │ pro  │ ✅ 启用   │ 2026-12-31   │ 12   │ 2024-01  │ 改到期 启停 删除     │ │
│  │ ☐ │ globex     │ Glob │ free │ ✅ 启用   │ 永不过期     │ 3    │ 2024-02  │ 改到期 启停 删除     │ │
│  │ ☐ │ wayne      │ Wayne│ ent  │ ⛔ 已禁用  │ 2025-08-01   │ 8    │ 2023-11  │ 改到期 启用 删除     │ │
│  └──────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────┘
```

- 列表：租户号 / 名称 / 套餐 / **状态（F2：active / disabled，AntD Tag 着色 `success` / `error`）** / **到期时间（F2：用 Day.js 渲染 ISO8601；「永不过期」灰色文字；过期红色）** / 用户数 / 创建时间
- 「创建租户」按钮：弹窗（租户号 / 名称 / 套餐 / **到期时间（可选，DatePicker，无填 = 永不过期）** / 初始管理员邮箱 + 密码）
- 「**改到期**」按钮（行操作，F2）：弹窗 DatePicker，可选「不限」清空到期
- 「**启停**」按钮（行操作，F2）：
  - 当前 `status='active'` → 显示「禁用」按钮，点击 → 二次确认 Modal → `PATCH /tenants/:id/status {status:'disabled'}`
  - 当前 `status='disabled'` → 显示「启用」按钮 → 二次确认 → `{status:'active'}`
  - `code='system'` 的初始租户 → 该按钮 `disabled` + Tooltip「不能禁用系统初始租户」
- 详情：租户的所有信息 + 该租户的统计 + 一键停用（F2 起改成「改到期」+「启停」两个独立按钮；删除独立 D5 流程）

**F2 配套的交互要点**：

- 状态变更（二次确认 Modal）：「**确认禁用租户 acme-corp？此租户下所有 admin / customer 账号将无法登录**」
- 启停之间：所有 audit_logs 留痕（`/system/audit` 也能查）
- 列表加载：默认按 `created_at DESC`，状态筛选支持单独显示 `disabled` 列表（无活跃租户运营只看历史）

> ✅ **2026-10-25 落地**（这一节以前只有 UI 草图，代码里没有）：
> - **搜索框 / 套餐筛选 / 状态筛选** —— 筛选在**服务端**做
>   （`GET /tenants?keyword=&plan=&status=`，租户多了以后前端筛不动）
> - **用户数列** —— 后端返回 `user_count`
> - **状态筛选多一个「已到期」** —— 到期是**算出来的**（`expires_at <= now`），
>   跟 `status='disabled'` 是两回事；不分开就查不出「哪些租户快到期 / 已到期」
> - **创建租户表单**加了套餐 + 到期时间（以前只能建完再去详情页改）
> - **租户详情的统计块**（用户数 / 会话数 / 文档数 / 累计花费）—— 全部按 tenant_id 过滤
> - 集成测试 `tests/integration/system-tenant-filters.test.ts`（9 个用例）

> ✅ **2026-10-26 补上 `/system/audit`（平台方的审计日志）** ——
> 上面那句「所有 audit_logs 留痕（`/system/audit` 也能查）」以前**没有对应的页面和端点**：
>
>   - **后端**：`GET /api/v1/system/audit` + `/audit/actions`（`src/gateway/system/audit-routes.ts`）
>     —— **跨租户 + 含系统级日志**（`tenant_id` 为空那类：平台方改租户启停 / 到期时间）
>   - **前端**：`/system/audit` 页面（跨租户表格 + 租户 / 操作类型 / 时间筛选 + 展开看 details）
>   - **跟租户后台的 `/admin/audit` 是两个视角**：租户 admin 只看得到本租户的
>     （后端强制 `tenant_id = 'x'`，SQL 里 `NULL = 'x'` 恒为 false，系统级日志天然看不到）；
>     平台方这边什么都看得到
>   - 集成测试 `tests/integration/system-audit.test.ts`（5 个用例，含「租户 admin 打过来 401」）
>
> ⚠️ **租户列表的「删除」按钮不做**（2026-10-26 确认）——
> 上面的 ASCII 草图里有「删除」，但 **12-e 的 F1 / F2 两条需求都没要求删租户**，
> 后端也没有 `DELETE /tenants/:id`。删租户牵涉一堆级联（会话 / 消息 / 文档 / 向量库 /
> 审计日志），不是加个按钮的事 —— 要做的话单独派活（走「软删 + 保留审计」的流程）。

### 6.2 总览 `/system/dashboard` ✅ 已落地 2026-10-24

> 实际路由是 `/system`（首页就是总览），不是 `/system/dashboard`。
> 数据来源：`GET /api/v1/system/stats`（新增端点，**跨租户口径**）。
>
> 内容：总租户数（启用 / 禁用 / 已到期）+ 总用户数 + 今日对话数 / 成本 + 7 天趋势图
> + 「成本超预算的租户」列表。
>
> ⚠️ **这是唯一返回跨租户数字的端点**，闸门是 `requireSystemUser` —— 租户 admin
> 调它会 401，租户级页面拿不到别的租户的任何数字。
>
> ⚠️ **「成本超预算」只看显式配过 `monthly_token_budget` 的租户** ——
> 平台默认值是 0（不限），没配过的租户不进这个列表。
>
> ⚠️ **趋势图的日期桶来自 `cost_logs`**（同 §5.1）：没有 LLM 调用的日子不画。

- 跨租户 KPI：总租户数 / 总用户数 / 总成本 / 总对话数
- 趋势图
- 异常租户告警（成本超阈值的租户）

---

## 7. 公共组件

| 组件                    | 用途                               | 位置                               |
| ----------------------- | ---------------------------------- | ---------------------------------- |
| `<RequireAuth>`         | 路由守卫，未登录跳登录             | `web/components/RequireAuth.tsx`   |
| `<ErrorBoundary>`       | 错误兜底，白屏防护                 | `web/components/ErrorBoundary.tsx` |
| `<Markdown>`            | Markdown 渲染（带代码高亮 + 复制） | `web/components/Markdown.tsx`      |
| `<Chart>`               | ECharts 图表封装                   | `web/components/Chart.tsx` ✅ 2026-10-26 抽出来了 |
| `<TraceTimeline>`       | Trace 时间线                       | `web/components/TraceTimeline.tsx` ✅ 2026-10-26 抽出来了 |
| `<ToolCallList>`        | 工具调用卡片（聊天气泡里的）       | `web/components/ToolCallList.tsx`  |
| `<ActiveModelsFooter>`  | 页脚展示当前激活 LLM / Embedding   | `web/components/ActiveModelsFooter.tsx` |
| `<Empty>` / `<Loading>` | 空状态 / 加载                      | AntD 自带                          |

> ✅ **2026-10-25 补了 3 个**（之前 `RequireAuth` / `ErrorBoundary` / `Markdown`
> 只在文档里写着，代码里没有）：
> - `<ErrorBoundary>` —— 挂在 `web/main.tsx` 的最外层（React 渲染时抛的异常
>   try/catch 接不住，没有它就是整页白屏）
> - `<RequireAuth>` —— 把三套 Layout 里各抄一遍的守卫逻辑收成一个组件
>   （没登录跳本子系统登录页 / 角色不对回 `/` / 被要求改密跳改密页）
> - `<Markdown>` —— 代码块 highlight.js 高亮 + 复制按钮、引用块蓝色边 + 浅灰底、
>   链接新窗口打开（04-b §4.7）。**highlight.js 的配色跟着深色模式切**
>   （用 Vite 的 `?inline` 拿 CSS 文本，按模式注入一份）。
>   单测 `tests/unit/markdown-component.test.tsx`（8 个用例）

> ⚠️ **消息气泡（`<ChatMessage>`）没有抽公共组件** —— 之前这张表里列过
> `web/components/ChatMessage.tsx`，但**该文件不存在**（写文档时凭空多写了一行）。
> 实际情况：customer 聊天页（`web/pages/customer/ChatPage.tsx`）和挂件页
> （`web/pages/widget/WidgetPage.tsx`）**各自内联**自己的气泡结构 ——
> 两边差异不小（customer 有 👍👎 反馈 / 引用卡片 / 工具卡片，挂件是匿名极简紧凑版），
> 强行合并的风险比收益大。两边的**用户气泡**已经统一了（时间戳 + 品牌色 token）。

> ✅ **2026-10-26 补齐了 `<Chart>` 和 `<TraceTimeline>`**：
>   - `<Chart>`：以前 4 个页面各自 `import ReactECharts` 直接用，高度 / `notMerge` 各写各的。
>     现在统一走封装（高度必填参数，`notMerge` 恒开 —— 数据点数量变化时不 merge，
>     否则旧折线会残留）。⚠️ option 用宽松的 `EChartsCoreOption` 类型
>     （各页面的 option 是对象字面量直接推出来的，严格类型会全部报类型错）
>   - `<TraceTimeline>`：以前那段 span 时间线的逻辑内联在 `ObservabilityTraceDetailPage` 里，
>     现在独立成组件（展开状态也收进组件内部，页面不用再管）

### 7.1 路由守卫

### 7.2 全局 Axios 拦截器

### 7.3 Markdown 渲染

### 7.4 页脚激活模型展示

3 个子系统的 Layout（`SystemLayout` / `AdminLayout` / `CustomerLayout`）的 `<Footer>` 末尾
挂一个 `<ActiveModelsFooter>`，显示当前生效的 LLM / Embedding 模型，让运营方随时
确认 `LLM_PROVIDER` 切到对的地方。

```
┌─ Footer ────────────────────────────────────────────────┐
│  system 子系统 · SaaS 平台方                              │
│  LLM · minimax · MiniMax-M3   Embedding · embo-01 · 1024d │
└──────────────────────────────────────────────────────────┘
```

- **数据来源**：公共元信息端点（active-config），详见相关需求文档
- **样式**：AntD `<Space size={16}>` + `<Text type="secondary">` + `<Text code>`，灰色小字，不抢主内容视觉
- **取不到数据**：静默显示「—」（譬如后端 503），不弹 toast，不影响页脚其他元素
- **登录页**：不走 Layout，**不**展示（按当前实现 login 页裸返回，无 Footer）
- **多租户期**：Step 9 落地 `tenants.settings.model` 后，**该展示保持「当前进程级 LLM」**——不展示每租户覆盖；运营方关注「底层接的是哪家」，租户级 model 切到对应「模型 & 提示词」配置页（见 `04-c-ui-后台管理页面.md`）

---

## 8. 交互模式

### 8.1 新手引导

- 首次进入 admin：显示「欢迎」对话框
- 流程：上传文档 → 等索引 → 测试问句 → 创用户
- 步骤 1 / 2 / 3 进度条，✅ 表示完成

### 8.2 空状态

- 知识库空：「还没有文档，先上传一个试试」（已实现，Table `locale.emptyText`）
- 评测集空：「还没有评测集，上传一份跑跑看」
- 历史会话空：「还没有对话记录，开始聊天吧」

### 8.3 加载状态

- 全屏加载：`<Spin size="large" fullscreen />`
- 局部加载：`<Skeleton />`（AntD 自带）
- 按钮：`<Button loading>` + 禁用其他按钮防止重复提交

### 8.4 错误状态

- 网络错误：toast「网络异常，请稍后重试」
- 401：跳登录
- 403：toast「没有权限」
- 500：toast「服务异常，已记录」+ Trace 链接

### 8.5 确认弹窗

- 删除 / 改密码等高风险操作：`<Modal>` 二次确认
- 「**确认删除这条用户？此操作不可撤销**」+ 取消 / 确认按钮

---

## 9. 主题与样式

### 9.1 AntD ConfigProvider

### 9.2 响应式断点

| 断点 | 宽度     | 处理                       |
| ---- | -------- | -------------------------- |
| xs   | < 576px  | 移动端（基本不用，但要做） |
| sm   | ≥ 576px  | 小屏                       |
| md   | ≥ 768px  | 平板（不太用）             |
| lg   | ≥ 992px  | 桌面（主要使用）           |
| xl   | ≥ 1200px | 大桌面（自动居中）         |
| xxl  | ≥ 1600px | 巨屏（自动居中）           |

- 主体目标：≥ 1280px 宽屏
- 后台在 < 992px 自动折叠 Sider
- 聊天挂件：嵌入网页后自适应宽度

### 9.3 暗色模式 ✅ 已落地 2026-10-24

- 右上角 ☀/🌙 按钮切换
- AntD `theme.darkAlgorithm`
- 持久化到 localStorage

**实现细节**：

- token 分三层写在 `web/theme.ts`：`brandToken`（两模式一样）/ `lightToken`·`darkToken`
  （背景·边框）/ `lightComponents`·`darkComponents`（Table·Modal·Tag·Breadcrumb 等）。
  ⚠️ 背景色**不能**共用一份 —— 否则 darkAlgorithm 拿到的还是白底。
- 开关状态放在 `web/lib/themeMode.ts`（模块级 store，不是 context）：
  根组件（`App.tsx` 的 ConfigProvider）和顶栏按钮在两棵不同的树里，store 更简单
- 顶栏按钮挂在 `web/layouts/SharedShellLayout.tsx` —— **3 套子系统的顶栏是同一份骨架**，
  改一处三个子系统都有
- **没存过时跟随系统 `prefers-color-scheme`**；用户手动切过之后以用户的选择为准
- 页面里凡是写死浅色的地方（`#fff` / `#f5f7fa` / `rgba(0,0,0,0.45)` 等）
  一律换成 `theme.useToken()` 的 token —— 否则暗色下会出现白底面板

---

## 10. 扩展性设计

> 未来要加新功能时，**菜单 + 路由**留好位置；不重写已有结构。

### 10.1 菜单的扩展点

- **业务面新功能**：在对应模块的 children 加菜单项
- **新业务模块**：在 Sider 顶层加一级菜单
- **未来可预见的**（菜单先占位 + 灰显）：
  - 「AI 工作流编排」
  - 「团队协作 / 多人会话」
  - 「API 开发者门户」
  - 「数据导出 / 报表」
  - 「计费 / 套餐管理」（多套餐时）

### 10.2 聊天功能的扩展点

| 现在的           | 未来加                                   |
| ---------------- | ---------------------------------------- |
| 文字             | 视频理解、文件理解                      |
| 思考模式         | 多模态思考（带图片推理）                 |
| 联网（占位）     | 真实联网检索                             |
| 历史会话列表     | 会话标签 / 收藏夹 / 共享会话             |

### 10.3 后台功能的扩展点

- 评测现在是大模型当裁判 → 未来加「人工标注」「A/B 测试」
- Trace 现在是单条 → 未来加「对比两条 trace」「trace 重放」
- 成本现在按月 → 未来加「按部门 / 按项目」拆解

### 10.4 插件机制（v2 考虑）

- 工具 = 插件（已通过 MCP 实现雏形）
- 提示词 = 模板库（v1 是文件 + 版本；v2 考虑模板引擎）
- 评测场景 = 插件（不同行业有不同评测集）

---

## 11. 验收标准

### 11.1 视觉 / 体验

- [ ] Ant Design 5 组件库（不混用其他 UI 库）
- [ ] 中文 locale 全栈一致
- [ ] 浅色 / 深色模式都能用
- [ ] 响应式：≥ 1280px 桌面 + ≥ 992px 平板 + < 992px 移动
- [ ] 加载 / 空 / 错误 三态都覆盖
- [ ] 所有按钮 / 输入框 / 表单 有 disabled / loading / 错误 状态

### 11.2 功能完整

- [ ] 3 个登录页（system / admin / account）可走通
- [ ] 聊天挂件：文字 / 思考模式 / 引用卡片 / 反馈 都能用
- [ ] 管理后台 12 个菜单项（含子菜单）都能进
- [x] 文档管理：上传 PDF/MD/TXT → 列表出现该文档、块数非 0、状态「已就绪」（2026-10-20 验证）
- [x] 检索测试：输问句 → 看到 top N 命中片段，每条带「语义第 N / 关键词第 N」标签（2026-10-20 验证）
- [ ] Trace 详情：时间线 + 单步详情
- [ ] 成本分析：4 个 Tab 都能切

### 11.3 性能 / 健壮

- [ ] 首屏 < 2 秒
- [ ] 路由切换 < 500ms
- [x] 错误边界兜底（白屏防护）—— ✅ 2026-10-25（`<ErrorBoundary>`）
- [~] SSE 断流重连 —— ⚠️ **2026-10-26 做了一半，明确说清楚差在哪**
  - ✅ **客户端能恢复**：断流后错误提示条上多一个「**重试**」按钮（把刚才那条问题重发一遍），
    消息气泡上本来就有「重新生成」
  - ❌ **服务端续传（自动 reconnect）没做**：AI SDK 的 `useChat({ resume: true })` 需要后端
    提供「按消息 id 重放流」的端点（`prepareReconnectToStreamRequest`），本项目没有 ——
    SSE 是**边生成边吐**的，持久化的 `messages.parts` 是**最终状态**而不是可重放的事件日志。
    要做续传，得先把流拆成可重放的事件序列存起来，是另一个量级的改动
  - ⚠️ **不做自动重试**：流断的时候上游可能已经算过 token 了，自动重发等于悄悄多花一次钱。
    让人点一下更保险
- [x] JWT 过期自动跳登录 —— ✅ 2026-10-25（401 拦截器跳本子系统的登录页）

### 11.4 国际化 / 扩展

- [ ] 主题切换持久化
- [ ] 菜单留好未来扩展点
- [ ] 文案抽到 `web/locales/zh_CN.json`（v1 可选）

---

## 12. 完整页面 / 路由清单

| 路由                              | 页面         | 角色              |
| --------------------------------- | ------------ | ----------------- |
| `/system/login`                   | 系统级登录   | SaaS 平台方       |
| `/system`                         | 系统总览     | SaaS 平台方       |
| `/system/tenants`                 | 租户列表     | SaaS 平台方       |
| `/system/tenants/:id`             | 租户详情     | SaaS 平台方       |
| `/system/audit`                   | 审计日志     | SaaS 平台方       |
| `/system/change-password`         | 改密码       | SaaS 平台方       |
| `/admin/login`                    | 租户后台登录 | 后台用户          |
| `/admin`                          | 首页看板     | 后台用户          |
| `/admin/knowledge/documents`      | 文档管理     | 后台用户（admin） |
| `/admin/knowledge/test`           | 检索测试 ★   | 后台用户          |
| `/admin/models`                   | 模型选择     | 后台用户（admin） |
| `/admin/prompts`                  | 提示词配置   | 后台用户（admin） |
| `/admin/tools`                    | 工具管理     | 后台用户（admin） |
| `/admin/tool-logs`                | 工具调用记录 | 后台用户（admin） |
| `/admin/evaluation/datasets`      | 评测集       | 后台用户（admin） |
| `/admin/evaluation/runs`          | 评测结果     | 后台用户（admin） |
| `/admin/observability/traces`     | Trace 列表   | 后台用户（admin） |
| `/admin/observability/traces/:id` | Trace 详情   | 后台用户（admin） |
| `/admin/observability/cost`       | 成本分析     | 后台用户（admin） |
| `/admin/users`                    | 用户管理     | 后台用户（admin） |
| `/admin/memories`                 | 用户记忆     | 后台用户（admin） |
| `/admin/audit`                    | 审计日志     | 后台用户（admin） |
| `/admin/api-keys`                 | API 密钥     | 后台用户（admin） |
| `/admin/settings`                 | 租户设置     | 后台用户（admin） |
| `/admin/change-password`          | 改密码       | 后台用户          |
| `/customer/login`                 | 前台用户登录 | 前台用户          |
| `/customer`                       | 用户中心首页 | 前台用户          |
| `/customer/chat`                  | 聊天主页     | 前台用户          |
| `/customer/memories`              | 我的记忆     | 前台用户          |
| `/customer/change-password`      | 改密码       | 前台用户          |
| `/widget/:tenantCode`             | 公开聊天挂件 | 匿名 / 前台用户   |

**共 31 个路由**（3 个登录 + 3 个改密 + 5 个 system + 19 个 admin + 5 个 customer + 1 个挂件）。

> ⚠️ **2026-10-26 订正**：这份清单以前跟实现对不上 ——
>   - 规格里写 `/system/dashboard` / `/admin/dashboard`，实现是 `/system` / `/admin`（首页就是 index 路由）
>   - 规格里写 `/admin/model` / `/admin/model/prompt`，实现拆成了 `/admin/models` + `/admin/prompts`
>     （C3 / C4 落地时按「三页分开」改的）
>   - 规格里列的 `/admin/observability/alerts`（告警规则页）**没做** ——
>     告警阈值改成通用配置页「成本」分类下的 3 个可配项了，**不占独立菜单**
>   - 补上了实现里有、规格里漏的：`/system/audit`、`/admin/memories`、`/admin/api-keys`、
>     `/admin/tool-logs`、`/customer`（用户中心首页）、三处 `/change-password`

---

## 13. 与其他文档的关系

- **数据模型**：`05-a-数据模型-mysql.md` + `05-b-数据模型-qdrant.md` —— 哪些字段需要在 UI 上展示
- **API 接口**：UI 调哪些端点（不在文档里列具体路径）
- **需求 ↔ 技术**：`12-*-需求技术对照表`（已拆 12-a..12-e）—— 每条 UI 需求用什么技术
- **代码示例**：UI 组件怎么写（不在文档里展示代码）

> 这份 UI 文档**只描述**长什么样 + 怎么交互；**不重复**讲数据模型 / API / 技术。
