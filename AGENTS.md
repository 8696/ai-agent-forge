# agents.md

> **项目实施的工作入口**。这一份不再写「必须 / 禁止 / 违反即 X」的命令——你（用户）口头告诉 AI 工程师做什么、用什么技术，AI 工程师就照做。文档作为参考存在，AI 工程师会先看，但你的口头指令优先。

---

## 1. 项目是什么

**多租户的 AI 文档问答平台**：

- 后台管理员上传文档（PDF / Markdown / TXT）
- 系统拆块 + Embedding 入向量库
- 前台用户通过对话向 AI 查询文档里的知识

参考需求清单：[12-需求技术对照表](./docs/12-a-需求-多租户与登录.md)（已拆分 12-a..12-e 五份，A~F 类需求按子文件查看）。**不强制实现**，由你口头派活。

**当前已交付**（事实记录）：

- Step 1 · 工程骨架（2026-10-13）
- Step 2 · 多租户 + 用户管理（2026-10-13）
- Step 3 · 三层登录 + 鉴权（2026-10-13）
- 知识库 + RAG 混合检索（2026-10-20）：文档列表 / 上传（同步拆块 + 向量化）/ 重新索引 / 删除 / 检索测试页。
  接口与验收见 [12-c](./docs/12-c-需求-管理员可配置.md) §C1，模块实现见 [07-c](./docs/07-c-模块-rag记忆状态协议.md) 模块 08-09
- B1 多轮对话 + LLM 流式（2026-10-21）：customer 前台聊天页 `/customer`（会话侧栏 / 流式回答 /
  引用卡片 / 停止 / 复制 / 重新生成 / 👍👎 / 思考过程）。后端 `/api/v1/customer/*`，
  走 Vercel AI SDK v7 的 SSE。验收见 [12-b](./docs/12-b-需求-ai对话能力.md) §B1，
  流式实现的坑见 [04-b](./docs/04-b-ui-登录与聊天挂件.md) §4.8.8-§4.8.9
- C3 提示词配置 + C4 模型选择（2026-10-21）：租户后台**三页分开**——
  `/admin/models`（模型列表，多条 + 启用切换）、`/admin/prompts`（提示词多版本，草稿→发布→回滚）、
  `/admin/settings`（通用配置 KV）。每轮对话读库，保存后立即生效不用重启。
  验收见 [12-c](./docs/12-c-需求-管理员可配置.md) §C3 §C4
- D 类运维稳定（2026-10-24）：**D4 安全防护**（脱敏 / 敏感词 / 注入检测+大模型二次确认）、
  **D5 限流 + 熔断 + 审计**（进程内 Map，租户 + 用户双维度，429 带 `Retry-After`；
  2026-10-25 补上**熔断** —— `src/lib/circuit-breaker.ts`，按 `provider|base_url` 分桶，
  连续失败到阈值就断开、期间快速失败、冷却后半开放一个探活）、
  **D3 成本控制**（`cost_logs` 表 + 月度 token 预算 + 后台顶栏告警条）。
  验收见 [12-d](./docs/12-d-需求-运维稳定.md) §D3 §D4 §D5
- **D1 评测 + D2 观测**（2026-10-24）：**D1**（评测集 JSONL + LLM-as-Judge 四维打分 + 后台异步跑批 +
  分数跌 10% 告警）、**D2**（`traces`/`spans` 两张表 + 一次对话 5 段 span 时间线 +
  `logs/trace-*.jsonl` 副本 + 成本分析 4 维度拆解 + p95/错误率/单条成本告警）。
  后台新增 5 个页面：`/admin/observability/traces`（+ 详情）、`/admin/observability/cost`、
  `/admin/evaluation/datasets`、`/admin/evaluation/runs`。
  验收见 [12-d](./docs/12-d-需求-运维稳定.md) §D1 §D2
- **两个 Dashboard 落地**（2026-10-24）：租户后台首页（`/admin`）= 4 张指标卡
  （今日对话数 / p95 延迟 / 今日成本 / 错误率）+ 7 天对话量 / 成本双图 + 异常告警列表
  （每条带跳转按钮，错误率超标 → `/admin/observability/traces?status=error`）；
  平台方总览（`/system`）= 跨租户 KPI + 7 天趋势 + 「成本超预算的租户」列表。
  平台方那边新增了 `GET /api/v1/system/stats` —— **唯一返回跨租户数字的端点**，
  闸门是 `requireSystemUser`（租户 admin 调它 401）。
  ⚠️ 两边的趋势图**日期桶来自 `cost_logs`**：没有 LLM 调用的日子不画
- **深色模式落地**（2026-10-24）：顶栏 ☀/🌙 按钮切换 + `localStorage` 持久化 +
  没存过时跟随系统 `prefers-color-scheme`。`web/theme.ts` 的 token 拆成了
  品牌 / 浅色 / 深色三层（**背景色不能共用一份**，否则切了暗色还是白底）；
  顶栏按钮挂在 `SharedShellLayout`（3 套子系统共用一份骨架）。
  页面里写死的浅色一律换成 `theme.useToken()` 的 token
- **E1 落地**（2026-10-24）：新增第 4 个子系统 `public/`（`/api/v1/public/*`）
  - **公开挂件 `/widget/:tenantCode`**（免登录，SSE 流式）：匿名会话用**签名 token**
    （`w1.<session_id>.<HMAC>`，走 `X-Widget-Token` 头、不进 URL）认领，
    关浏览器再打开历史还在
  - **对外 REST API**：`POST /api/v1/public/chat`（JSON）+ `/chat/stream`（SSE），
    **API Key 鉴权**（`ak_<nanoid(32)>`，prefix 粗筛 + bcrypt 比对 + 60s 进程内缓存，
    后台撤销立刻失效）
  - **后台 `/admin/api-keys` 管自己的 key**（新建 / 列表 / 撤销；完整 key 只显示一次）
  - 鉴权命名空间跟 system/admin/customer **完全独立**（JWT 打过来 401，反之亦然）
  - 验收见 [12-e](./docs/12-e-需求-业务接入与平台运营.md) §E1
- **用户写操作补审计**（2026-10-24）：建用户 / 改用户 / 删用户以前**一次都没写审计**，
  而 D5 的验收明写着「建用户 → audit_logs 有记录」。现在补上
  `USER_CREATED` / `USER_UPDATED` / `USER_DELETED`（密码永远不进 `details`），
  `AuditAction` 联合类型也跟代码里实际写入的 action 对齐了
- **审计日志的读侧落地**（2026-10-24）：`GET /api/v1/admin/audit`（分页 + 筛选）
  + `/api/v1/admin/audit/actions`（真实 action 清单），后台页面 `/admin/audit`。
  ⚠️ 只看得到**本租户**的日志 —— 系统级日志（`tenant_id` 为空）租户 admin 看不到
- **2026-10-25 补的规格缺口**（审计出来的一批「文档写了、代码没做」，逐条补齐 + 配测试）：
  - **前端公共组件（04-d §7）**：`<ErrorBoundary>`（挂在 `main.tsx` 最外层，
    React 渲染异常 try/catch 接不住，没它就是白屏）、`<RequireAuth>`
    （三套 Layout 里各抄一遍的守卫收成一个组件）、`<Markdown>`
    （代码块 highlight.js 高亮 + 复制按钮 + 引用块蓝色边 + 链接新窗口，
    **配色跟着深色模式切** —— 04-b §4.7 的三条一次性补齐）
  - **401 自动跳登录**（04-d §11.3）：拦截器跳**本子系统**的登录页；
    ⚠️ 「改密码时旧密码不对」也是 401，但那不代表 token 过期 ——
    清 token 会把正在改密的用户白踢一次，所以单独排除了这个端点
  - **消息右上角小时间戳**（04-b §4.2）：后端在 `metadata.created_at` 带出
    `messages.created_at`，前端按「今天只显示 HH:mm」渲染
  - **租户列表**（04-d §6.1）：搜索框 / 套餐筛选 / 状态筛选（**服务端**筛，
    多一个「已到期」——到期是算出来的，跟 disabled 两回事）+ 用户数列 +
    创建时能带套餐和到期时间 + 租户详情的统计块
  - **用户管理**（04-c §5.8）：状态列 + 状态筛选（活跃/已锁定）、
    编辑抽屉能改角色（不能改自己的）
  - **租户设置页**（04-c §5.9）：基础配置只读块（租户名/号/套餐）、
    **告警阈值改成租户可配**（3 个新配置项，`alerts.ts` 改为按租户读）
  - **查询改写**（12-b §B2，`src/rag/query-rewrite.ts`）：把口语化问题改成检索友好的形态。
    **默认关闭** —— 每轮多一次模型调用（多 1~3 秒 + 一份花费），
    而短问题（「年假几天」）改写基本没收益；改写失败一律回落原查询
  - **LLM 重试 + 抖动**（12-d §D5 / 07-e 模块 19，`src/lib/retry.ts`）：
    AI SDK v7 **有指数退避、没有抖动** —— 上游挂着时所有并发请求在同一毫秒
    一起重试，把刚要恢复的上游再打死一次（惊群）。本层用**全抖动**
    （`random(0, min(cap, base*factor^n))`），尊重 `Retry-After` 头，
    包住**非流式**的 LLM 调用（流式中途失败已经吐了一半，重来会吐两遍）
  - **租户隔离的架构约束测试**（12-a §A1 的「不该有没有 scope 的 findAll 应该被拦」）：
    `tests/unit/tenant-isolation-guard.test.ts` 扫 `src/` 里所有租户级模型的查询，
    没带租户过滤就让测试红；确实不需要带的（作用域是已校验归属的父级）
    必须逐条登记在白名单并写清理由，白名单有过期条目也红。
    ⚠️ **为什么不用 lint** —— `yarn lint` 现在跑不起来（typescript-eslint 不支持 TS 7），
    「靠 lint 拦」这条路是断的，就用项目已有的 D6 测试基建约定来兜

- **2026-10-25 修的 6 个「标了 ✅ 但功能没生效 / 没实现」的洞**（审计发现的，代码已修 + 有回归测试）：
  - **C3 提示词整条链是断的**（最严重）：`prompt_version` 这个 KV key
    **没注册进 `SETTINGS_REGISTRY`** —— 写侧 `saveSettings` 抛 ValidationError
    （发布接口返 400，但版本已经被标成 production 的**半成功**），
    读侧 `getSettingValue` 直接返回 null → **租户发布的提示词从来不会生效**。
    连带 D1 的「故意改坏提示词 → 分数跌 10%」触发不了。
    修法：注册进 registry（`hidden: true`，通用配置页不露出）+ 发布/回滚与
    「写生效指针」进**同一个事务**（根治半成功）。
    回归测试 `tests/unit/tenant-config.test.ts`
  - **C4 编辑模型时 `base_url` 不做 SSRF 校验就落库**：「编辑时留空 API Key = 保持原样」
    是后台的**默认路径**，这条路径直接 `row.base_url = input.base_url` ——
    绕开了新建时的闸门，租户 admin 在生产环境能把端点指到 `169.254.169.254`。
    修法：`normalizeBaseUrl` 抽出来，新建/编辑共用。
    回归测试 `tests/integration/admin-model-ssrf.test.ts`
  - **D5 需求正文的「熔断」从没实现**（需求句写着「限流 + 熔断 + 审计日志」，标题标着 ✅）。
    修法：`src/lib/circuit-breaker.ts`（closed / open / half-open 三态，
    按 `provider|base_url` 分桶），接在对话链路的 `streamText` 前后。
    回归测试 `tests/unit/circuit-breaker.test.ts`
  - **A4 的 `/me` 和 `/change-password` 端点被删过**（注释写着「前端未用」）——
    19 个验收用例缺 6 个，`must_change_password` 从建表起就没人消费。
    修法：三套子系统各补一套端点 + 标志签进 JWT + 服务端闸门
    （被标记的账号除 `/me` 和 `/change-password` 外一律 **403**）+ 前端强制改密页。
    回归测试 `tests/integration/auth-me-change-password.test.ts`
  - **API Key 没有 scope 权限分级**：规格写着「权限按 scope 分（只读 / 写入 / 管理员）」，
    但 `api_keys` 表**从来没有 scope 列** —— 一把 key 能调该租户的全部对外端点，
    而对外的 key 是**发到客户系统里**的。
    修法：迁移 `020-add-api-key-scope.ts` + `requireApiScope` 闸门 +
    一个只读端点 `GET /api/v1/public/search`（查知识库，不调 LLM、不花钱）——
    **没有它「只读」这个级别就是空的**。后台页面能建时选、能随时改（立刻生效）。
    回归测试 `tests/integration/api-key-scope.test.ts`
  - **深色模式下挂件页 / 登录页 / 404 页仍是白底**（9 处写死浅色）——
    与「页面里写死的浅色一律换成 token」的交付声明矛盾。
    修法：`theme.pageGradient()` + 挂件页改用 `theme.useToken()`；
    `body` 背景改成跟 `<html data-theme>` 联动

- **B3 / B5 / B6 / C2 曾改标「暂不做」，后四条全部落地了**（2026-10-25 → 2026-10-26）：
  需求池扩容到 25 条的过程中，这 4 条（B3 工具调用 / B5 状态机工作流 /
  B6 多代理协作 / C2 工具管理）被判「暂不做 · 等外部系统接入需求」，
  理由是「工具调用的作者和调用者都是租户，平台侧没有自调用者」。
  **2026-10-25 当晚定位改了** —— 改成「先用平台内置的 mock 工具函数把工具循环跑通」，
  **B3 / C2 当天落地**；**B5 / B6 次日（2026-10-26）也落地了**
  （B5 走「路径 B」：先定流程状态图 → 再手写工作流引擎；B6 走监督者模式，
  **两条都没上 LangGraph**，评估见 [07-d 模块 13](./docs/07-d-模块-框架与多代理.md) §13）。
  **25 条编号需求现在全部落地**（权威落点见
  [12-e 需求裁定表](./docs/12-e-需求-业务接入与平台运营.md)）。
  **原来那条「触发条件」现在指向的是「更重的能力」而不是「补做 B5 / B6」**：
  租户要接自己的 ERP / 工单 / 预约 · 被要求能「动」数据而不只是「读」·
  挂件接入方要 AI 调他们自己的接口 · 定位扩到「AI 客服 / Agent 平台」
  —— 真触发时要做的是**真出网的 `http` / `mcp` 工具**
  （当前 `http` 只是本地 mock），而不是把 B5 / B6 重做一遍
- **工具的 DDL 补了三个洞**（2026-10-25）：`tools` 表漏了 `tenant_id` 列
  （按原 DDL 建表会报 MySQL 1072）、索引非唯一（跟「工具名租户内唯一」的要求对不上）、
  `type` 枚举少了 **`http`**（原本只有 `builtin` / `mcp` —— 中间那类最常见的
  「租户自己有 REST 接口」无处可落）。`missions` 补了 `idx_tenant_state` 索引。
  另外记了一条：`http` 工具的出网策略**不能照抄 LLM Base URL 那套 SSRF 闸** ——
  `http` 工具的正常用法就是调租户内网系统，现有闸生产默认禁私网，会把正当用途全挡掉
- **B4 用户长期记忆**（2026-10-24）：记忆分三层 —— 短期（会话历史，B1 已做）/
  摘要（`sessions.summary`，下轮做）/ **长期**（本轮做的）。
  新增 `user_memories` 表（一条 = 一条关于用户的事实，分 画像/偏好/事实/情境 四类）。
  **三级更新机制**：T1 正则信号预筛（零成本，挡住大部分对话）→ T2 调 LLM 抽取
  （把现有记忆一起喂进去，模型自己决定新增/改写/归档）→ T3 用户或管理员手动改。
  注入走 system prompt（拼在检索资料段**前面**，冲突时以资料为准），
  每轮 top N 条 + token 预算双重裁剪。
  **两个页面**：租户后台 `/admin/memories`（左用户右记忆的双栏，租户 admin 能看/改/归档
  本租户每个用户的记忆）、前台 `/customer/memories`（用户看自己的、能改能删能一键关掉自动记忆）。
  验收见 [12-b](./docs/12-b-需求-ai对话能力.md) §B4，模块实现见
  [07-c](./docs/07-c-模块-rag记忆状态协议.md) 模块 10
- **B4 补三项**（2026-10-24）：
  - **抽取模型可独立配置**：`tenant_models` 加 `usage_scope`（`chat` / `memory`），
    `/admin/models` 的模型条目多了「用途」。**每个 scope 各自一条启用项**，
    抽取的回落链是「抽取模型 → 对话模型 → 平台默认」（不配也能用，行为跟以前一样）。
    意义：抽取是独立的一次 LLM 调用（推理型模型的思考 token 全额算输出 token，
    一次实测 2000+），租户单独配条便宜模型是唯一能压这项成本的手段
  - **抽取进 trace/span**：抽取写一条**独立**的 trace（`kind='memory'`，
    `name='memory.extract'`）+ 三段 span（`llm.extract` / `cost.record` / `storage.apply`）。
    故意不挂在对话那条 trace 上 —— 对话 trace 的 duration_ms 要保持「用户感知的耗时」
  - **客户侧物理清空**：`DELETE /customer/memories/permanent`（清空全部）+
    `DELETE /customer/memories/:id/permanent`（单条）—— 归档只是软删，
    用户行使「删除我的全部个人数据」的权利时要的是真删
- **B4 记忆检索落地**（2026-10-26 · 补 [07-c 模块 10](./docs/07-c-模块-rag记忆状态协议.md) 那一项）：
  注入哪几条记忆**从「按固定顺序」改成「按跟当前问题相不相关」**
  - **向量存 `user_memories` 表上**（迁移 `035`）：`embedding`（归一化后的 float 数组，JSON）
    + `embedding_model`（生成它的模型名 —— 换 embedding 模型后据此判定旧向量作废）。
    ⚠️ **不放 Qdrant** —— `user_memories` 有 `tenant_id` 列 → Sequelize 的租户作用域钩子
    自动补过滤，**向量存在这一行里就自动继承了租户隔离**；放向量库得重新手写一遍租户过滤，
    那等于给自己开一个跨租户的口子。量级也小（单用户 ≤ 50 条自动记忆 + 手写那几条），
    几百条向量在 DB 里算余弦是毫秒级
  - **排序：相关性是主序，优先级兜底**（来源 > 置信度 > 更新时间）。
    ⚠️ **没有向量的记忆按 0 分算**（跟「有向量但不相关」同档）—— 不会被「缺向量」饿死
  - **写入时算向量**（新建 / 改内容 / 自动抽取后**批量**补算，都是尽力而为）；
    存量数据在下一轮对话**后台补算**（不阻塞那一轮）
  - **两层开关**：平台 `.env` 的 `MEMORY_RELEVANCE_ENABLED`（总开关）∧
    租户 `memory_relevance_enabled`（通用配置页「记忆」分类，默认开）
  - **任何一步失败都退回固定顺序**：embedding 服务挂 / 没配 / 迁移没跑 →
    功能少一半，**对话不受影响**
  - 代码 `src/services/memory-relevance.ts`（向量数学 + 排序 + 降级）+
    `src/services/memory.ts` 的 `buildMemoryContext`
  - 测试 `tests/unit/memory-relevance.test.ts`（纯函数）+
    `tests/integration/memory-relevance.test.ts`（DB + 假 embedding，不产生费用）
- **B1 摘要压缩落地**（2026-10-24）：超长会话不再只「截断」——
  被裁掉的早期轮次会调一次 LLM 折成摘要写进 `sessions.summary`，**下一轮注入上下文**。
  - **边界标记**：`sessions.metadata.summary_boundary` 记「摘要覆盖到哪条消息为止」，
    下一轮按它把历史切成两段 —— 边界之前的不再喂原文（否则原文 + 摘要两种说法并存）
  - **滚动重写**：输入是「旧摘要 + 新丢掉的轮次」，输出是一份全新的完整摘要（不是追加）
  - **摘要模型可独立配**：`tenant_models.usage_scope` 加了第三个取值 `summary`
    （迁移 `019`），回落链「摘要模型 → 对话模型 → 平台默认」
  - **摘要写独立 trace**：`kind='summary'` / `name='session.summarize'`，不挂对话 trace
  - **租户开关**：`summary_enabled` / `summary_token_budget`（通用配置页「记忆」分类）
  - **实测**：`max_history_turns=1` 连发 4 轮，第 4 轮问「我刚才说我叫什么」答对了
    （那条原始消息早就在上下文窗口外，只靠摘要记着）
  - 验收见 [12-b](./docs/12-b-需求-ai对话能力.md) §B1.1，实现见
    [src/services/session-summary.ts](./src/services/session-summary.ts)
- **B7 前台首页工作台**（2026-10-24）：**租户前台首页原来跟「智能问答」是同一个组件**
  （`/customer` 和 `/customer/chat` 都渲染 `ChatPage`），首页这个位置实际是空的。
  现在拆开：首页 = 概览 + 入口（欢迎语 / 推荐问题 / 最近会话 / 知识库 / 我的记忆四块），
  聊天页 = 纯对话
  - **两个新端点**（customer 命名空间，角色鉴权）：
    `GET /api/v1/customer/profile`（租户名 + 首页欢迎语 + 推荐问题）、
    `GET /api/v1/customer/documents?limit=N`（知识库文档元信息，
    **不返** `file_path` / `source` / `error_message`）
  - **两个新租户配置项**（`/admin/settings` 的「首页」分类，保存后立即生效）：
    `home_welcome_message`（留空按租户名兜底）、
    `home_suggested_questions`（一行一条，最多 8 条 / 每条 100 字）
    —— 通用配置页**第一次出现 string 类型**（以前只有 number / boolean），
    带 `maxLength` 上限 + 多行输入框
  - **跳转协议**：`/customer/chat?q=<问题>` → 建新会话并自动发出去，
    URL 随即 `replace` 成 `?session=<id>`（刷新不会重复问一遍）；
    `/customer/chat?session=<id>` → 直接打开指定会话
  - ⚠️ **踩过的坑**：自动发送**不能在 mount effect 里直接调** `sendMessage` ——
    `useChat` 在 unmount 时会调 `chat.stop()`，而 StrictMode 下 mount effect 跑完
    立刻 cleanup，正好把 `sendMessage` 内部「消息准备」阶段的 abort controller 取消掉，
    **消息永远发不出去而且不报错**（看起来像卡在「正在检索知识库…」）。
    解法：`setTimeout(0)` 延后一拍再发，让 cleanup 先过去
  - 验收见 [12-b](./docs/12-b-需求-ai对话能力.md) §B7，
    UI 规格见 [04-b](./docs/04-b-UI-登录与聊天挂件.md) §4.10
- **B2 重排序落地**（2026-10-25）：RRF 融合**之后**、截断 topK **之前**加了一层重排
  - 新增 `src/rag/rerank.ts`（重排客户端）+ `src/rag/hybrid-search.ts` 的 `rerankAndTrim`
    （融合 → 重排 → 截断的编排，独立导出方便单测）
  - **协议是 Cohere 兼容的** `POST {RERANK_API_URL}`，body `{model, query, documents, top_n}`，
    响应 `{results:[{index, relevance_score}]}` —— 自建的 `bge-reranker-v2-m3`（起一个
    Cohere 兼容服务）、硅基流动、Jina、Cohere 都吃这个格式，**换供应商只改 `.env` 不改代码**
  - **`.env` 的 `RERANK_API_URL` 留空 = 不做重排**（配好地址即生效，不用再翻开关）；
    另配 `RERANK_ENABLED` / `RERANK_MODEL` / `RERANK_TIMEOUT_MS` / `RERANK_CANDIDATES`
  - **两层开关**：平台 `RERANK_ENABLED`（硬边界）+ 租户 `rerank_enabled`
    （通用配置页「知识库」分类的 `rerank_enabled`，租户能单独关掉自己的重排）
  - **降级**：重排调不通（网络 / 超时 / 5xx / 响应格式不对）自动退回纯 RRF 顺序，
    检索整体不挂；日志 warn 一条「重排失败，本次降级为纯 RRF 排序」
  - **`score` 的语义随开关变**：重排生效时是重排分（超出 [0,1] 的按批次 min-max 归一化），
    降级时才是归一化 RRF 分；原始值另存在 `rerank_score` 里
  - 对话链路的 `retrieval.search` span 多一个 `rerank_applied` 字段；
    后台「检索测试」页多一个「已重排 / 未重排」标记 + 每条的「重排」分标签
  - 验收见 [12-b](./docs/12-b-需求-ai对话能力.md) §B2，模块实现见
    [07-c](./docs/07-c-模块-rag记忆状态协议.md) 模块 09
- **B3 工具调用 + C2 工具管理落地**（2026-10-25）：AI 在对话里**真的调工具**，
  工具结果回灌上下文后再作答（不是编的）
  - **实现放代码，注册放数据库**：代码侧 `src/tools/builtin/`（**8 个**内置 mock 工具：
    订单状态 / 商品信息 / 物流轨迹 / 可用优惠 / 知识库清单 / 提交退款申请 / 修改收货地址 /
    创建售后工单 —— 电商客服场景；后两个是 2026-10-26 为 B5 工作流补的）；
    数据库侧 `tools` 表存租户的注册（调用名 + **描述** + 启停 + 敏感标记）
  - **描述是给模型看的** —— 租户能改 → 能「调教模型调不调它」。这是 C2 真正的价值，
    改完下一轮对话立刻生效
  - **接的是 AI SDK 的自动工具循环**（`streamText({ tools, stopWhen: stepCountIs(5) })`），
    不手写 while 循环；`toUIMessageStream` 必须传 `tools` 才转 part
  - **每次工具调用**：一条 `tool.invoke` span + 一条 `data-tool-call` part（落库，刷新后卡片还在）
  - **敏感工具要人工确认**（HITL 最小实现）：闸门在执行前拦下 → 前端卡片上「确认执行」/「取消」
    → 批准记录写进 `sessions.metadata.approved_tool_calls`（**30 分钟过期**）→ **下一轮的
    系统提示词主动提醒模型「用同样的参数再调一次」**（不然模型回一句「好的」就完了，工具根本没跑）→ 真执行
  - **HITL 的三个细节**：① 模型改了参数 → 闸门把「用户已确认的那组参数」回传给它，
    用户不用再点一次；② 用户点「取消」→ 闸门回「用户拒绝」，**不再问第三次**；
    ③ 挂件（匿名会话）也能确认/取消 —— 会话是 token 认领来的，挂在 `public/widget` 命名空间下
  - **后台 `/admin/tools`**：注册 / 启停 / 试连 / 改描述；重名 400、跨租户 404、全部写审计
  - **后台 `/admin/tool-logs`**：工具调用流水（一行 = 一次调用，带**请求参数**和**响应参数**，
    可按工具 / 状态 / 时间 / 关键词筛）—— 数据落 `tool_call_logs` 表（迁移 `024`），
    由工具执行包装层写入（唯一出口，不会漏记）
  - **`http` / `mcp` 两类暂不开放**（出网 SSRF 策略还没定，端点层直接拒绝 400）
  - **前置的持久化修复**：`messages.tool_results` 曾经被重载装 data part，
    迁移 `023-messages-parts-column` 把它挪到新列 `messages.parts`（实测搬了 74 行）
  - 验收见 [12-b](./docs/12-b-需求-ai对话能力.md) §B3、[12-c](./docs/12-c-需求-管理员可配置.md) §C2
- **B5 Agent 状态机 + 工作流落地**（2026-10-26 · 走「路径 B」：先定流程状态图 → 再手写引擎）：
  **没有上 LangGraph** —— 评估见 [07-d 模块 13](./docs/07-d-模块-框架与多代理.md) §13
  （B5 专项见 [12-b §B5.1](./docs/12-b-需求-ai对话能力.md)）
  - **三条电商流程的状态图**（先定义「流程长什么样」，再决定用什么实现）：
    退款申请 / 收货地址修改 / 售后工单 —— 全是**线性**的，各 2~3 个节点
  - **`missions` 表**（迁移 `028`）：6 个状态
    `pending` / `running` / `awaiting_confirmation` / `completed` / `failed` / `cancelled`，
    加 `current_step`（断点恢复靠它知道从哪继续）+ `approval_key` + `expires_at`
  - **通用引擎**（`src/workflows/`）：流程定义是**数据**（`types.ts`），
    引擎只管按定义执行（`engine.ts`）—— 加一条流程 = 加一条定义，**不改引擎**
  - **闸门接入**（`src/tools/execute.ts` 的 `runtime.gate`）：工具执行前先问引擎
    「这一步能不能走」，四种结果 `allow` / `await` / `blocked` / `reject`。
    ⚠️ **注入了闸门就完全接管判断**（引擎内部已覆盖 B3 的敏感工具规则）
  - **`blocked` 是新的一档拦截**（迁移 `029` 给 `tool_call_logs.status` 加的 ENUM 值）：
    「前置步骤没满足」—— 模型想直接提交退款但还没查过订单，
    闸门回一句「请先调用 query_order_status」。**不是失败，是流程约束**
  - **批准 / 取消端点同时推进任务状态**（`awaiting_confirmation` ⇄ `running` / `cancelled`）
  - **断点恢复**：任务状态落 DB，恢复时由提示词把「这个流程走到哪了」告诉模型
    ⚠️ **本方案是「模型驱动」的** —— 引擎不会自己往前走，
    得等用户再说一句话模型才会继续调（LangGraph 是「图驱动」，这是两者最实质的差别）
  - ⚠️ **批准令牌和任务账本是两张表**：`sessions.metadata.approved_tool_calls`
    存**授权令牌**（30 分钟 TTL），`missions` 存**流程账本**（按节点推进）——
    生命周期不同所以没合并
  - 验收见 [12-b](./docs/12-b-需求-ai对话能力.md) §B5 §B5.1；
    测试 `tests/integration/workflow-missions.test.ts`（状态机 + 跨租户隔离）、
    `tests/unit/workflow-definitions.test.ts`、`tests/unit/tool-execute.test.ts` 的「工作流闸门」一节
  - ⚠️ **LangGraph 到底要不要上：已全量评估（2026-10-26），结论「暂不上」** ——
    **权威落点是 [07-d 模块 13](./docs/07-d-模块-框架与多代理.md) §13**
    （25 条需求逐条判定 + 成本分析 + 4 条「改主意的信号」）
    ⚠️ **别再重复论证这件事** —— 需求池里 23/25 条跟「图」无关，
    图形状的只有 B5 和 B6（**两条都已用手写做完**）
- **按裁定表做完了 6 项（2026-10-26 第二批）**：
  - **`http` 工具 = 本地 mock**（`src/tools/http-mock.ts`）：保留 url/method 的配置形状，
    但**平台不真的发请求**，按 `(租户, url, method, 入参)` 确定性生成响应；
    入参 schema 按租户声明的字段生成；模拟状态码非 2xx 走「调不通」降级。
    ⚠️ **`tools.type` 的 `mcp` 仍保留在枚举里，但端点层拒绝（400）**
  - **C2 敏感字段不回明文**：工具列表/详情只回 `url`/`method`，
    **不回 `mock_response` 原文**（租户填的响应内容可能含敏感信息）；审计同样只记 url
  - **C4 备用模型 + 自动 failover**（迁移 `030` + `src/lib/llm-failover.ts`）：
    `tenant_models.fallback_model_id` 指向**同租户同 scope**的另一条；
    非流式调用（记忆抽取 / 会话摘要）无条件切；
    ⚠️ **流式对话只在「一个内容 chunk 都还没吐出去」时才切** ——
    吐出去的字收不回来，重切会让重复的 tool call **真的执行两遍**
  - **会话收藏**（迁移 `031`）：`PATCH /sessions/:id/favorite`（不传 body = 切换），
    列表支持 `?favorite=true`，侧栏有星标 +「只看收藏」筛选
  - **告警规则页** `/admin/observability/alerts`：三条固定规则（p95 / 错误率 / 单条成本），
    阈值可配 + 启停（阈值设 0 = 关掉这一条）
    ⚠️ **顺手修了一个「文档说一套、代码做另一套」的 bug**：
    阈值说明写着「设 0 = 不看这一项」，代码却是 `v > 0 ? v : 默认值` —— 设 0 反而用回默认值
  - ✅ **「prompt 改动自动跑小规模回归」也做了**（2026-10-26 · 迁移 `033`）：
    提示词**发布 / 回滚**后自动跑一次小规模评测（`src/services/prompt-regression.ts`）
    - **只跑前 10 题**（一次题 = 2 次 LLM 调用，跑全集 = 100 次）
    - **异步 + 永不阻塞发布**（没评测集 / 评测关着 / 起跑失败 → 一律跳过）
    - 跑批行记 `run_trigger='prompt_regression'`（手动跑是 `manual`），列表里能看出来
    - ⚠️ **列名不能叫 `trigger`** —— 那是 MySQL 保留字（`ADD COLUMN trigger` 直接语法错）
    - ⚠️ **是「发布后验证」不是「发布前门禁」** —— 新提示词已经生效才跑回归
- **B6 多代理协作落地**（2026-10-26 · 监督者模式 · **没用 LangGraph**）：
  - **模式**：主 agent 通过平台内置工具 `delegate_to_agent` 把子任务派给专业子代理，
    子代理查完把结论回灌，主 agent 综合作答
  - **三个内置子代理**（`src/agents/subagents.ts`）：订单代理 / 政策代理（会检索知识库）/ 优惠代理
  - **⚠️ 安全底线：子代理只拿只读工具。** 写操作（退款 / 建工单）**留给主 agent** ——
    那些要走 HITL 闸门（用户点确认才执行），而闸门挂在对话链路的工具执行层上，
    **子代理不在覆盖范围内**。让子代理拿着敏感工具跑 = 开了一条绕过用户确认的后门。
    `subAgentTools()` 静默剔除敏感实现，有单测守着
  - **落地时拍板的两个决策**（当时是待拍板的）：
    ① 「trace 看得出调用树」→ **给 span 加了父子关系**：
       `spans.parent_span_id` 这列**建表时就有但一直没用过**（`span()` 恒写 null），
       现在 `trace.span(name, kind, input, parentSpanId?)` 支持指定父 span，
       前端 `TraceTimeline` 按父子关系缩进渲染
    ② 「共享状态用什么载体」→ **独立两张表**（迁移 `032`：`agent_runs` + `agent_steps`），
       **没塞进 `sessions.metadata`**（每轮都要读 + 共享状态会越滚越大）。
       `turn_id` 定位「本轮」—— 一轮里的多次委派属于同一批次
  - **共享状态是引擎直接注入**（`renderSharedState`）—— 不是主 agent 转述
  - **租户可关**：`multi_agent_enabled`（通用配置页 → 模型分类，默认开）。
    ⚠️ 委派是**额外的一次 LLM 调用**，成本比普通工具高
  - ⚠️ **这次实现本身就是「LangGraph 暂不上」的最硬证据**：
    监督者模式用「一个委派工具 + 一次非流式 `generateText` + 一张共享状态表」就够，
    **LangGraph 的每个核心增量都用不上**（见 07-d §13.5 的逐项对照）
  - ⚠️ **e2e 实测踩出的三个坑**（改这块代码前先看 [12-b §B6 已知边界](./docs/12-b-需求-ai对话能力.md)）：
    ① `generateText` 默认 `stopWhen` 是 `stepCountIs(1)` —— 子代理调完工具就结束、正文为空
    ② 推理模型的思考 token 全额算输出 token —— 输出上限 1024 不够（用 2000）
    ③ **span 的父 id 必须一路转发**（`trace.span` 第 4 个参数）——
       中间哪一层没转发，调用树就断在那儿
- **「还有哪些需求没做」已全量裁定（2026-10-26）· 唯一权威落点
  [12-e 需求裁定表](./docs/12-e-需求-业务接入与平台运营.md)**：
  - ⚠️ **裁定的两步判据**（用户 2026-10-26 定）：
    **第一步 · 要不要外部系统配合？** 要（租户那边得自己跑服务 / 平台方得买外部 API）
    → **不做**，不用再论证。
    **第二步 · 纯系统内部的，看有没有被「手动标明不做」** ——
    有人手动标明 → **不做**（照标明走）；没人标明 → **做**。
    ⚠️ **「手动标明」= 需求文档里写了「不做 / 移出需求」，或用户明确拍板判为不做**
  - **表 2（18 项 defer 小块）**：8 项已落地 / 10 项不做
    （3 项走「外部依赖」+ 7 项走「纯内部 · 手动标明不做」）；
    **表 3（6 项移出需求）**：转人工 / Word 解析 / 定时跑全量评测 / 删除租户 /
    租户可配安全开关 / §1.5 其余 Out of Scope 项
  - **MCP 决定不做**（跨多个系统：租户那边得自己跑一个 MCP server）
    —— `tools.type` 的枚举值保留，端点层拒绝（400）
  - **`http` 工具改成「本地 mock」**（`src/tools/http-mock.ts`）：保留 url/method 的
    配置形状，但**平台不真的发请求**，按 `(租户, url, method, 入参)` 确定性生成响应
  - **C4 备用模型 + 自动 failover 已落地**（迁移 `030` + `src/lib/llm-failover.ts`）：
    租户级自动切（平台级仍是人工切 `.env`）；
    ⚠️ **流式对话只在「还没吐过内容」时才切** —— 吐出去的字收不回来
  - **下次被问「还有什么需求没做」→ 直接看那张表，不要再给模糊描述**
- **「要不要用 LangGraph」已全量评估过（2026-10-26）· 唯一权威落点 [07-d 模块 13](./docs/07-d-模块-框架与多代理.md) §13**：
  - **25 条需求里 23 条跟「图」无关**（主体是 CRUD + 检索 + 鉴权 + 观测，不是编排）
  - **B5 已用手写引擎做完**（`missions` 表 + `src/workflows/`），三条流程全线性，
    LangGraph 的主要增量（checkpointer 自动续跑 / 并行 fan-out / 多代理 handoff）当前一条都不需要
  - **B6 多代理也用手写做完了**（监督者模式：委派工具 + 一次非流式 `generateText` +
    共享状态表 + trace 调用树）—— **B5 + B6 两条都没碰 LangGraph 的核心增量**，
    这就是「暂不上」的实打实证据（逐项对照见 07-d §13.5）
  - **⚠️ 上 LangGraph 的成本大头不是框架，是「你已有的 AI SDK 流式栈」**：
    流式协议要重写（前端 `useChat` + `messages.parts` 落库 + 引用卡片三层一起动）、
    MySQL 版 checkpointer 官方没有要自己写、两套 tracing 要适配。
    **真正的决策是「多代理 / 可变拓扑，值不值得重写一遍流式栈」**
  - **4 条改主意的信号**（硬/软分级）见 07-d §13.6 —— 出现任何一条就重新评估
- **2026-10-26 补的「标 ✅ 但机制没到位」+ UI 缺口**（一次全量审计后的整改）：
  - **A1 租户隔离有了运行时强制**（最大的那条）—— 以前隔离是「靠人记得加 `tenant_id` 过滤」，
    现在**请求级租户上下文 + Sequelize 全局钩子自动补过滤**（`src/lib/tenant-context.ts` +
    `src/lib/tenant-scope.ts`）：`beforeFind` / `beforeCount` / `beforeBulkUpdate` /
    `beforeBulkDestroy` 四个钩子；显式查了别的租户 → 抛 `TenantIsolationError`（500，故意显眼）。
    平台方（system）**不设上下文** —— 它本来就要跨租户看数据
  - **约束测试也变强了**（`tests/unit/tenant-isolation-guard.test.ts`）：模型清单**从 `src/models/`
    自动推导**（以前手写 17 个，漏了 `TenantSetting`）、查询方法清单补全（`findAndCountAll` /
    `bulkCreate` 以前漏扫）、**剥离注释后再扫**（文档里引用一句 `Document.findAll()` 不算违规）、
    判定从「出现过 tenant_id 这个词」升级到「where 的来源里有 tenant_id 键」+ 写死租户 id 报错
  - **F2「防自锁」不再是永远触发不到的分支** —— 防御代码保留（平台方自建 `code='system'` 的租户
    时会拦），但**验收测试把前提造出来验证它**（`tests/integration/f2-tenant-lifecycle.test.ts`）；
    同一个文件补上了「禁用 / 到期的响应体与密码错**逐字段完全一致**」这条断言
  - **A4 的三条验收补上了端到端测试**（`tests/integration/auth-login-lock.test.ts`）：
    5 次失败 → 锁定（DB 状态正确 + 正确密码也 401）+ 成功后计数清零 —— 以前只有内存 helper 的单测
  - **平台方能查全部审计日志了**（`/system/audit`）：新增 `GET /api/v1/system/audit` +
    `/audit/actions`（**跨租户 + 含系统级日志**），后台页面 `/system/audit`。
    租户 admin 那条路仍然只看得到本租户的
  - **D4 脱敏没有开关了**（原来 `.env` 的 `SECURITY_PII_MASK_ENABLED` 能关掉）——
    脱敏是「写进历史库前的最后一道防线」，能关就等于允许把身份证明文存库
  - **思考模式开关落地**（04-b §4.4 标着「核心功能」但前后台都没有）：
    前台聊天页 + 挂件页输入区都有「思考模式」勾选框 → 请求体带 `thinking` →
    后端 `resolveThinkingBudget` 决定预算（租户配了 > 0 一直生效；没配但用户勾了 → 用 1024 的兜底预算）
  - **UI 规格的 17 项缺口补齐**：用户菜单加「修改密码」入口（以前**没有任何入口**能进改密页）、
    窄屏（< 992px）自动折叠侧栏、403/500 的专门文案（「没有权限」/「服务异常，已记录」）、
    登录页的副文案 + 「忘记密码」留位 + 「记住我」（不勾就存 sessionStorage）+ 卡片宽度 400、
    租户号校验规则**前后端共用一份**（以前前端三份手抄正则，建租户那处还漏了长度校验）、
    侧栏按规格分成 7 组（以前 16 个平铺）、挂件的用户菜单（历史记录 / 登录 / 退出）+ 历史记录抽屉、
    `data-truncated` 不再是 transient（**刷新后也能看到截断提示**）、
    `<Chart>` / `<TraceTimeline>` 两个封装抽出来了、`<WidgetLayout>` 独立成文件、
    `/dev/probe` 只在 Vite dev 模式下注册（生产构建里这个路由不存在）、
    `CHAT_SUMMARY_TARGET_CHARS` 这个死配置接上了摘要提示词、`zustand` 这个没用到的依赖移了
  - **docs 与代码对不上的一批也订正了**：12-d 的「重试本期未做」和「告警阈值是代码常量」
    其实都做了（2026-10-25 补的，12-d 没同步）；AGENTS.md 的「通用配置页 16 项」
    实际已经是 20 项 + 1 个隐藏项
  - **顺手修了一个真 bug（不是这轮任务里的，是测试跨零点时暴露的）**：
    **原生 SQL 的时间窗口有时区错位** —— MySQL 的 DATETIME 列按 **UTC 墙钟**存，
    但 `sequelize.query` 的 `replacements` 把 Date 渲染成**本地**墙钟字符串，
    两边对不上。症状：**「今日对话数 / 今日成本」在每天的前 8 小时（UTC+8）恒为 0**。
    修法：`src/lib/sql-datetime.ts` 的 `utcWallClock()`，11 处原生查询全部改用它
    （`src/services/observability.ts` 8 处 + `src/services/system-stats.ts` 4 处）。
    ⚠️ **走模型查询的地方不受影响**（`Op.gte` 那条路径按 UTC 绑定参数，是对的）
- **需求文档 ↔ 代码的全量对照审计**（2026-10-26）：把 `12-a`..`12-e` 五份需求文档
  与代码**逐条对齐**了一遍，订正了文档里过期的路径 / 数字 / 措辞
  （挂件端点漏了 `:tenantCode`、E2 的存储其实是 `tenant_settings` 三张表、
  F2 的响应文案实际是「与密码错完全一致」而不是「租户不可用」、
  `lru-cache` / `@anthropic-ai/sdk` 装了但零 import、24 模块汇总的数量算错，等等）；
  同时补齐了代码侧的若干缺口：平台方写操作补审计（`TENANT_CREATED` /
  `TENANT_UPDATED` / `TENANT_ADMIN_PASSWORD_RESET`）、HITL 两条路径补
  `tool.invoke` span、模型 `usage_scope` 的 Sequelize ENUM 补 `summary`、
  审计页补两个中文标签、新增迁移规范字符集与引擎、补齐 A2/A3/A4 缺的端到端用例。
  逐条对照的落点在 `docs/12-a`..`12-e` 五份需求文档里（各自的「验收」小节）
- **修掉审计里查出的两条「文档说一套、代码做另一套」**（2026-10-26）：
  - **D1 评测的检索口径没跟线上对齐**：评测只调
    `hybridSearch({query, tenantId, topK})` —— **不传 `rerankEnabled`、也没有查询改写**。
    租户一旦改了这两个开关，评测跑的检索就不是线上那一套，**分数不能代表线上表现**
    （「改坏提示词 → 分数跌 10%」的基线就歪了）。
    修法：新增 `src/rag/retrieval-plan.ts` 的 **`planRetrieval()`**，
    **线上对话（`chat.ts`）和评测（`evaluation.ts`）都走它** —— 口径靠结构保证一致；
    改写的超时常量也归到一处（`query-rewrite.ts` 的 `QUERY_REWRITE_TIMEOUT_MS`）。
    ⚠️ **代价**：租户开了查询改写，评测每题多一次 LLM 调用（2 次/题 → 3 次/题）——
    这是「跟线上对齐」的必然成本，租户自己开的开关评测跟着付。
    回归测试 `tests/unit/evaluation-retrieval.test.ts` +
    `tests/unit/retrieval-plan.test.ts`（后者还含「两侧必须走同一个入口」的结构性守卫）
  - **B5.1.2 文档写的 `end` 节点在代码里不存在**：节点**没有 `type` 字段**
    （`WorkflowNode` = `tool` + `confirm` + `requires` + `title`），
    **终点是隐式的**（引擎找不到「下一个节点」即 `completed`）。
    ⚠️ 照着文档加一个 `end` 节点 → 引擎把它当成「还没做的下一个节点」→
    mission 卡在 `running` **再也到不了 `completed`**。文档已订正并写明这个坑
- **同一次审计查出的 5 处「文档数字过期」也一并订正**（2026-10-26）：
  - 内置工具「**6 个**」→ **8 个**（12-b 的清单表还漏列了 `update_shipping_address` /
    `create_after_sale_ticket` 两个 —— 它们是 B5 流程 `modify_address` /
    `after_sale_ticket` 的触发节点，已补进表里）
  - 通用配置项「**21 项**」→ **22 项**（21 可见 + 1 隐藏的 `prompt_version`）；
    12-c §C4 的「租户可覆盖 vs 留平台级」表补上了漏掉的 `multi_agent_enabled`（B6 开关）
  - `data-*` part「**共四种**」→ **共五种**（多的是 `data-tool-call` —— B3 的工具调用卡片，
    它落库 `messages.parts`，刷新后卡片还在）
  - **需求数仍是 25 条**（不是 26）—— **B1.1（会话摘要压缩）是 B1 的子项**，
    不单独占名额；12-e 的裁定表 + 索引表已改成跟这个口径一致（索引表里 B1.1 单列一行，
    因为它有自己的实现落点）
  - 三处注释指向**不存在的** `src/workflows/definitions.ts` → 改成
    `src/workflows/types.ts` 的 `WORKFLOWS`（`Mission.ts` / 迁移 `028` / `workflows/engine.ts`）
  - ✅ **加了守卫测试** `tests/unit/docs-consistency.test.ts`：机械核对
    「内置工具 key 集合」「registry 条数」「data part 类型集合」三处文档数字
    —— 改了代码忘了改文档，它就红（已做过扰动验证：把数字改回旧值确实会失败）
- **E1 的两个已知缺口补齐**（2026-10-26 · 用户口头派活）：
  - **`admin` scope 从「空档」变成真能力**（`src/gateway/public/admin-api-routes.ts`）：
    `admin` 档 = 写入的全部能力 + **管理本租户的知识库**
    （`GET /api/v1/public/documents`、POST 同路径上传、`DELETE /api/v1/public/documents/:id`）。
    ⚠️ **之前这是个陷阱**：枚举里有 `admin`、后台下拉里能选，但对外 API **没有任何 admin 端点**
    → 用户能建出一把「看着比 write 大、实际能力等价于 write」的钥匙。
    按裁定表的判据（纯内部 · 没人标明不做 → 该做）选了**补端点**而不是从下拉里删掉
  - **上传 / 索引 / 删除抽成共用服务**（`src/services/document-ingest.ts`）——
    admin 后台和对外 API 走**同一套实现**，免得两条路长歪；
    `src/gateway/admin/knowledge-routes.ts` 改成调它（删掉本地的三份实现）
  - ⚠️ **admin 档能删文档** —— 这是新引入的边界，租户自己决定给不给外部系统这一档；
    后台表单里明写了「拿到这把 key 的系统可以清空知识库」
  - **鉴权不再全表扫**（迁移 `034-add-api-key-sha256.ts`）：
    `api_keys.key_sha256` = sha256(完整 key) + 唯一索引 → **索引点查**定位到那一行，
    再用 bcrypt 验真。以前只按 8 位 `key_prefix` 查（走不了索引 → 全表扫）。
    存量 key（sha256 为 NULL）走慢路径，**第一次鉴权成功时自动回填**（自愈）
  - ⚠️ **「代码先于迁移上线」不再是个坑**（同批次补的）：
    生产是「DBA 手动跑迁移 + 灰度」（docs/11），**代码可能先上线**。
    而 Sequelize 的 SELECT 列清单来自**模型定义** —— 列不存在时
    **任何**对 `api_keys` 的查询都会报 `Unknown column 'key_sha256' in 'field list'`
    （鉴权 + 后台的密钥列表 / 改权限 / 撤销**全挂**）。
    修法：**启动时探一次**（`probeApiKeySha256Column`）→ 列不在就
    `ApiKey.removeAttribute('key_sha256')` 把这一列从模型里摘掉
    → 所有查询退回老行为（前缀粗筛 + bcrypt），只是慢一点，不会挂。
    ⚠️ **摘列**是关键 —— 只改 WHERE 没用（列清单来自模型定义）。
    验证工具：`node scripts/check-api-key-degradation.mjs`
    （在 scratch 库里造出「代码新、schema 旧」的状态逐条验）
  - 回归测试 `tests/integration/public-admin-api.test.ts`（权限分级 / 跨租户隔离 /
    删除留审计 / sha256 回填）+
    `tests/unit/api-key-sha256-degrade.test.ts`（降级判定）

- **A/B 对比落地（2026-10-26）** —— 需求裁定表里**最后一项「没人标明不做」的纯内部项**
  （[12-e](./docs/12-e-需求-业务接入与平台运营.md) 表 4）做完了。
  做完之后「**还有什么需求没实现**」这个问题**没有答案了** ——
  编号需求 25 条全落地、defer 小块该做的都做了、两项「高级能力」一项做了（对比）一项不做（邮件渠道 · 外部依赖）
  - **跑批能指定提示词版本**：`POST /api/v1/admin/evaluation/runs` 的 body 加了可选的
    `prompt_version` —— 不传 = 跟随租户当前生效的版本（**原有行为不变**），
    传 `null` = 显式用内置默认，传版本号 = 用那一版。
    ⚠️ **版本不存在直接 400，不静默回落默认**（`assertPromptVersionUsable`）——
    回落会让「这一版比上一版好还是差」的对比结果**骗人**。
    校验在**跑批创建之前**做 → 不会留下一个跑不动的半成品 run
  - **对比接口**：`GET /api/v1/admin/evaluation/compare?run_id_a=&run_id_b=`
    （`src/services/evaluation.ts` 的 `compareRuns`）
    → 四维 + 总分的 A/B/差值、token/成本/题数差值，外加**逐题**谁更好谁更差。
    ⚠️ 路径是 `/evaluation/compare` **不是** `/evaluation/runs/compare` ——
    后者会被 `/evaluation/runs/:id` 那个动态路由抢先匹配掉
  - **逐题配对**（`matchComparisonItems`，纯函数单测）：
    同一个评测集按 `item_id` 精确配 → 配不上按题目文本兜底 → **一对一**
    （B 侧每条明细最多被领走一次）
  - **后台页** `/admin/evaluation/compare`：选两次跑批 → 汇总 + 逐题表；
    「评测结果」页勾选两条也能直接跳过去。侧栏「评测」组新增一项
  - **顺带修的一处隐患**：`prompt-regression`（提示词发布自动回归）现在
    **显式传刚发布的版本号**，不再依赖「当前生效指针」——
    发布和回归之间隔着一次 HTTP，中间租户可能又发了一版，显式指定才不会跑偏
  - 文档同步：[12-e 表 4](./docs/12-e-需求-业务接入与平台运营.md)、
    [12-d §D1](./docs/12-d-需求-运维稳定.md)、[12-c §C3](./docs/12-c-需求-管理员可配置.md)、
    [04-c §5.6.3](./docs/04-c-ui-后台管理页面.md)、[04-a 菜单树](./docs/04-a-ui-总则布局与菜单.md)、
    [08 §8.3](./docs/08-评测方案.md)、[01 §1.8](./docs/01-需求与场景.md)
  - 测试：`tests/unit/evaluation-compare.test.ts`（配对纯逻辑）+
    `tests/integration/evaluation-compare.test.ts`（三种版本语义 + 400 + 对比接口 + 跨租户）
    —— **全程零 LLM 费用**（`vi.mock` 把 `ai` / 检索 / 凭据都假掉）

- **`.env` / `.env.example` 的结构契约落地**（2026-10-27）：
  两个文件各漂了半年没人管 —— `.env` 少 6 个 key（2026-10-26 那批功能上线时
  **只改了 `.env.example`**）、`.env` 还多一个**死 key** `SECURITY_PII_MASK_ENABLED`
  （脱敏开关 2026-10-26 就从代码里摘掉了，文件里的行还留着）。
  - **「哪个 key 该存在」的唯一依据 = `src/config.ts` 的 `envSchema`**
    （例外只有 7 个，清单在 `scripts/env-contract.ts` 的 `OPTIONAL_ENV_KEYS`）
  - **`scripts/sync-env.ts` 重写**（当年从没被跑过，而且会把 `.env` 独有的 key
    追加到文件末尾、还把 dev 的远程地址抄进进 git 的模板 —— 现在结构漂移直接报错退出）
  - **命令**：`yarn env:sync`（同步）/ `yarn env:check`（只校验，漂了退出码 1）
  - **兜底测试** `tests/unit/env-consistency.test.ts`
    （key 集合 / 顺序 / 注释结构一致、无死 key、无漏配、secret 行留空）
  - 约束写在 [§4.3](#43-涉及环境变量-env--envexample)

**已知限制**（不主动修，等你派活）：

- **「转人工」已明确移出需求**（2026-10-25，理由见 [01 §1.5](./docs/01-需求与场景.md)）：
  本系统**没有「客服坐席」这个角色**（`users.role` 的 `'agent'` 只是历史 ENUM 留位，
  代码层面拒收它登录任何子系统），也**没有「AI 答不上来」的判定机制**
  （没有置信度、没有「检索为空就拒答」的闸门）。没有坐席就没有转接对象 ——
  「转人工」在本产品里只能是「一个租户自己配的联系方式字符串」，不是一项功能。
  ⚠️ `sessions.status` 的 `'transferred'` 枚举值**保留**（将来真做工单流转时用得上），
  但它现在全库无人写入或读取。
  将来租户真需要给用户一个客服联系方式时，那是一个**新配置项**（类似
  `home_welcome_message`），跟这条不是一回事 —— 单独派活。

- **B7 前台首页的四个已知边界**（详见 [12-b](./docs/12-b-需求-ai对话能力.md) §B7）：
  - **前台用户能看见本租户全部文档的标题**（拿不到正文）—— 产品决策，
    内部知识库清单通常不算敏感；要藏得给这个端点加开关（**本期没做**）
  - **欢迎语不支持变量插值**（`{{user.name}}` 这种），只支持纯文本
  - **首页四个请求是四个独立 HTTP 请求**，没有聚合端点 —— 弱网下会分批上屏
  - **「最近会话」只看标题和最后活动时间**，没有会话摘要预览

- **重排序的七个已知边界**（详见 [12-b](./docs/12-b-需求-ai对话能力.md) §B2）：
  - **每轮对话多一次外部调用**（网络 + 推理，本机自建通常几百毫秒到 1~2 秒）；
    `RERANK_TIMEOUT_MS` 默认 8 秒，超了就降级（宁可排序差一点也不拖住用户请求）
  - **多一次成本**（重排模型按 token 计费，自建就是 GPU / 电费），
    **且这一笔不计入 D3 的 `cost_logs`** —— 成本分析里看不到重排花了多少
  - **候选池默认 20 个**（`RERANK_CANDIDATES`，上限 100）：越大重排能纠正的范围越大，
    但也越贵越慢
  - **不做重试**：重排调不通直接降级（重试会把延迟翻倍）——
    想要高可用得在重排服务前面自己挂重试 / 熔断
  - **只改排序，不改召回**：真正该召回的块没进候选池，重排也救不回来
    （那是召回率问题，得调 embedding 或 BM25）
  - **`score` 的语义随重排开关变**（重排分 vs 归一化 RRF 分）——
    跨检索比较分数时得留意
  - **租户级只有一个开关**：不能按租户换重排模型或端点（平台统一一套，`.env` 配置）

- **B5 / B6 的已知边界**（两条都已落地 2026-10-26 · 详见 [12-b](./docs/12-b-需求-ai对话能力.md) §B5 §B6）：
  - **B5 流程定义写在代码里**，租户改不了流程图；三条流程都是线性的，没有环路和回退
  - **B5 是「模型驱动」的**：引擎不会自己往前走，断点恢复靠提示词告诉模型走到哪了，
    得**等用户再说一句话**模型才继续调下一个工具（LangGraph 的 checkpointer 是图自己往下跑）
  - **B5 的流程状态存在 `missions`，节点结果在 `mission.context`**（JSON 列，没有强 schema）
  - **B6 多代理的 token 成本是单代理的数倍**（委派是额外一次 LLM 调用），
    租户可在「模型 → 多代理协作」开关关掉（`multi_agent_enabled`，默认开）
  - **B6 子代理是平台内置的三个固定角色**，租户改不了；共享状态只放产出不放中间过程
  - **B6 一轮大约只能委派 2 次**（工具循环上限 `TOOL_MAX_STEPS = 5`，一次委派占 2 步）
- **工具的六个已知边界**（详见 [12-b](./docs/12-b-需求-ai对话能力.md) §B3）：
  - **内置工具是 mock**：订单 / 商品 / 物流 / 优惠券 / 退款单都是按租户 + 编号确定性生成的假数据，
    不会真的进任何业务系统（`list_knowledge_documents` 是唯一查真实数据的）
  - **`http` 已开放，但只是「本地 mock」**（2026-10-26 · `src/tools/http-mock.ts`）：
    保留「租户配 url/method」的形状，**平台不真的发请求**，
    按 `(租户, url, method, 入参)` 确定性生成响应；真出网要打到租户自己的服务器，
    出网策略还没定
  - **`mcp` 不做**（用户 2026-10-26 拍板 · 跨系统）：枚举值保留，端点层直接拒绝（400）
  - **工具耗时计入 `llm.generate` span** → 「用户感知延迟」会被工具耗时拉长（工具本身有 5 秒上限）
  - **HITL 的批准记录寄在 `sessions.metadata.approved_tool_calls`**（授权令牌，30 分钟 TTL），
    **流程账本在 `missions` 表**（按节点推进）——
    ⚠️ **有意没合并成一张表**：两者生命周期不同（令牌会过期，账本不会）
  - **闸门一旦注入就完全接管判断**：引擎内部的规则覆盖了 B3 敏感工具那套
    （`src/tools/execute.ts` 的 `runtime.gate` 有 `allow` / `await` / `blocked` / `reject` 四种结果）
- ~~**antd v6 的废弃 API 警告刷屏**~~ —— ⚠️ **2026-10-26 补记：那批迁移其实漏了 8 处**，
  「**控制台不再刷警告**」这句当时是**不成立的**：
  - 大部分确实迁了（`Alert message` → `title` 54 处、`Space direction` → `orientation` 5 处、
    `Modal`/`Drawer destroyOnClose` → `destroyOnHidden` 14 处、`Drawer width` → `size` 6 处）
  - ⚠️ **漏的 8 处**（2026-10-26 数据库恢复连通后跑 e2e 时才发现）：
    `Alert message`（`ObservabilityAlertsPage` 2 处 / `ModelListPage` 1 处 / `ToolsPage` 1 处）、
    `Space direction`（`ModelListPage` 1 处）、
    `Drawer width`（挂件页历史记录抽屉 1 处）、
    `Modal maskClosable`（`ApiKeysPage` 1 处）
    —— **全在后台页面和挂件抽屉里，之前的 e2e 只访问登录页 / 守卫 / 深色模式 / 挂件，
    后台页面压根没被打开过，警告只在组件渲染时才打**
  - ✅ **现在真的不再刷了**，而且加了两层守卫防止再漏：
    - **静态**（`tests/unit/antd-deprecated-props.test.ts`）：扫源码，
      **组件在不在页面上、抽屉开没开都算** ——
      「藏在没打开的抽屉里的 Alert」这种运行时扫不到，静态能扫到；
      清单是 antd v6.6.6 里**真会运行时告警**的属性（不是类型层的软废弃），
      每个用例还会回 antd 源码确认「这个属性确实还在废弃列表里」
    - **运行时**（`tests/e2e/antd-deprecation.spec.ts`）：真开浏览器，
      把租户后台 18 个页面 + 平台方 3 个页面 + 挂件全访问一遍，
      控制台里出现 `[antd: ` 开头的废弃警告就红
- ~~**深色模式下写死浅色看不见**~~ —— ✅ **2026-10-26 清完**：
  34 处 `rgba(0,0,0,*)` 里的文字色 / 背景色 / 边框色全换成 antd token
  （`colorTextTertiary` / `colorTextSecondary` / `colorFillQuaternary` / `colorFillTertiary` /
  `colorFillSecondary`），图表配色也改成走 token；滚动条按 `html[data-theme]` 分深浅两套。
  **「页面里写死的浅色一律换成 token」这条现在真的做到了**
- **上传格式只有 PDF / Markdown / TXT**：Word（.docx）解析 **2026-10-25 已移出需求**
  （不是待办，见 [01 §1.5](./docs/01-需求与场景.md) §1.5）；库里的 `file_type` ENUM
  也去掉了 `'word'`（迁移 `021`）
- **租户隔离的运行时强制可以被一个 env 开关整层关掉**：`TENANT_SCOPE_ENFORCE=false`
  （`src/config.ts` / `src/lib/tenant-scope.ts`，默认 `true`）——
  关掉就退回「全靠人记得加 `tenant_id` 过滤」。
  ⚠️ 这个开关跟 D4 把脱敏开关摘掉的处理**不一致**（脱敏不给开关），
  留着它是因为隔离关掉后还有约束测试 + 静态扫描挡着，是个止血阀。
  详见 [12-a §A1](./docs/12-a-需求-多租户与登录.md)
- BM25 索引是**进程内内存索引**，单实例有效；多实例部署时各实例关键词召回不一致
- 上传走同步索引，大文件会占住 HTTP 连接
- **上传的文档落磁盘是明文**（没做落盘加密）——
  🚫 **不做**（用户 2026-10-26 拍板）：文档落在自建部署的磁盘上，访问控制靠部署方的
  文件权限；落盘加密要额外引入密钥管理与轮换，收益不抵成本。
  见 [12-e 裁定表](./docs/12-e-需求-业务接入与平台运营.md) #13
- **摘要压缩的六个已知边界**（详见 [12-b](./docs/12-b-需求-ai对话能力.md) §B1.1）：
  - **摘要滞后一轮**：本轮丢掉的轮次要到下一轮才进摘要（摘要是 fire-and-forget 的）
  - **摘要是有损压缩**：模型改写过的内容跟原文不完全一致，细节可能丢
  - **长对话每轮可能多一次 LLM 调用**：可以关（`summary_enabled=false`）
    或配一条便宜的「会话摘要」模型压成本
  - **摘要是进程内 fire-and-forget**：进程在写完前被 kill，这段摘要就丢了（下一轮重来）
  - **同会话的摘要任务串行化是进程内的**：多实例部署时闸门不跨进程，
    但重复摘要只是多花一次钱，不会写坏数据（写之前会重读边界）
  - **摘要块在 system prompt 里不是消息**：模型看到的是「一段早期对话的摘要」，
    语义上略差，但检索型问答影响不大
- **B4 长期记忆的已知边界**（详见 [12-b](./docs/12-b-需求-ai对话能力.md) §B4）：
  - ~~**摘要压缩（`sessions.summary`）还是没做**~~ —— 2026-10-24 已做，见上面「B1 摘要压缩落地」
  - **抽取是 fire-and-forget**：对话结束几秒后记忆才落库，
    「刚说完就立刻追问」的那一轮用不上新记忆
  - **抽取要额外花一次 LLM 调用**（实测约 2000 token，推理型模型的思考 token 占大头）：
    T1 预筛挡住了大部分对话，但「有个人信息」的轮次必然多这一次成本。
    **可以压**：租户在 `/admin/models` 单独配一条「记忆抽取」用途的便宜模型
  - **抽取是进程内 fire-and-forget，没有跨实例的锁**：同一用户快速连发两条都带自我表述的
    消息，可能抽出两次同一条记忆（已用「插入前查库判重」把窗口压到很窄，但没根治）。
    注意这不是「多实例各抽一次」—— 一轮对话只由一个实例处理，只抽一次
  - **抽取只改得动「最近 50 条」记忆**：模型能改写 / 归档的目标 id 取自喂给它的
    现有记忆快照（`updated_at DESC limit 50`），第 51 条之外的记忆模型碰不到
  - **记忆没有遗忘机制**：只增不减，靠单用户 50 条 `auto` 记忆封顶 + 冲突时归档收敛；
    「三个月前的岗位」这类过时信息要靠模型自己改写
  - ~~**记忆注入没有做相关性排序**~~ —— ✅ **2026-10-26 已做**（`07-c` 模块 10 的「记忆检索」那项）：
    迁移 `035` + `src/services/memory-relevance.ts`，注入哪几条按「跟当前问题相不相关」排。
    ⚠️ **代价与降级**：每轮多一次 embedding 调用（租户开关 `memory_relevance_enabled` 可关）；
    embedding 服务挂了 / 没配 / 迁移没跑 → **退回固定顺序**，不影响对话
  - **相关性排序的三个限制**（2026-10-26）：存量记忆的向量是**下一轮才补上**的
    （后台补算，不阻塞那一轮）· 没有向量可用的记忆按 0 分算（跟「有向量但不相关」同档，
    不会被饿死，但也没法靠相关性排上来）· **不写绝对阈值**（不同 embedding 模型
    「不相关」的相似度基线差很多，写死阈值换个模型就失效 —— 只做相对排序）
  - **「本轮用了哪几条记忆」查不到**：注入时算出的 `injected` / `dropped` 没回传前端，
    聊天页也没有任何记忆提示；`hit_count` 只有累计数，没有 per-turn 记录
- **Prompt Caching 接了但实测无效**：`cacheControl` 已经打上了
  （`src/services/chat.ts`，受租户级「提示词缓存」开关控制），
  但智谱的 Anthropic 兼容端点把系统提示词映射到 `instructions` 字段，
  而 `cache_control` 只对 `messages` 里的 content block 有意义 → `cache_read_tokens` 恒为 0。
  原生 Anthropic 端点上应该可用（**未实测**）
- **联网开关不做**（用户 2026-10-26 拍板 · 跨系统：要接外部搜索 API，
  平台方得买 key / 额度，且外部服务不可控）；
  **会话收藏已做**（迁移 `031` + `PATCH /sessions/:id/favorite` + 侧栏星标 +「只看收藏」筛选）
- **E1 的已知边界**（详见 [12-e](./docs/12-e-需求-业务接入与平台运营.md) §E1）：
  - **挂件 / 对外 API 的会话没有清理机制** —— 匿名会话永远留在 `sessions` 表里
  - **匿名场景限流挡不住「一个人开十个浏览器」** —— 匿名没有身份可限
  - ⚠️ **`admin` scope 能删文档**（2026-10-26 补的端点带来的新边界）——
    拿到 admin 档 key 的外部系统可以清空本租户的知识库。
    这是「管理员」这一档的定义，租户自己决定给不给；后台表单里写明了这条风险
- **D1 评测的三个已知边界**（详见 [12-d](./docs/12-d-需求-运维稳定.md) §D1）：
  - **跑批是后台异步的**（接口返 202），不是同步跑完
  - **单次跑批最多 50 题**（`EVALUATION_MAX_ITEMS`）：一条题 = 2 次 LLM 调用（生成 + 裁判），
    这是成本闸门；200 条的评测集可以建，要分批跑
  - **「prompt 改动自动跑小规模回归」已做**（2026-10-26 · 迁移 `033` +
    `src/services/prompt-regression.ts`）：发布 / 回滚后异步跑前 10 题，**永不阻塞发布**；
    ⚠️ **「每天定时自动跑全量」仍不做**（要常驻定时器 + 外部调度，成本不可控），
    全量评测只支持手动触发
- **A/B 对比的四个已知边界**（2026-10-26 · 详见 [12-d §D1](./docs/12-d-需求-运维稳定.md)）：
  - **一次 A/B 对比 = 两跑批 = 成本翻倍** —— 50 题的两批 = 200 次 LLM 调用。
    省钱的做法是用**小评测集**（1~5 题）做对比，或用「提示词发布自动回归」那 10 题
  - **逐题明细上限 2000 条**（`COMPARISON_ITEM_LIMIT`）：超了截断并在提醒条里说明
  - **不是流量分流的 A/B** —— 是「同一批题跑两遍」的**离线对比**，
    没有「按流量分给两个版本」那回事（那需要同时挂两个提示词版本在线上服务）
  - **对比结果不保证「差异只来自提示词」** —— 两次跑批如果模型不同 / 知识库变了 /
    题目顺序影响生成，差异里都有别的东西。页面的提醒条会把「模型不同」「同一个版本」
    这两种最常见的情况点出来，但**不是所有干扰源都能自动识别**
- **D2 观测的五个已知边界**（详见 [12-d](./docs/12-d-需求-运维稳定.md) §D2）：
  - **trace 是结束时一次性写的**（内存里攒 → 一个事务写 trace + spans）：
    进程在请求中途被 kill 会丢这一条 trace
  - **观测指标是实时聚合查询**，没有分钟级聚合表（`docs/09` §9.2 的 `metrics_minutely`）：
    trace 到百万级时查询会变慢
  - **指标告警的窗口是「今天」不是 5 分钟**（`docs/09` §9.4 的设计稿是 5 分钟）
  - **告警阈值已改成租户可配**（2026-10-25 · 通用配置页「成本」分类 3 项，
    填 0 = 不看该项）；`docs/04-c` §5.7.4 的「告警规则」页也已落地（2026-10-26，
    三条固定规则 + 阈值可配 + 启停）
  - **「客户端断开」不算错误**（记 success）：否则用户自己关页面会把错误率刷高
- ✅ **`messages.tool_results` 挪走已完成**（迁移 `023-messages-parts-column`，
  data part 搬到新列 `messages.parts`）—— 这是 B3 工具调用的前置修复，已不再是待办
- **租户自定义 apiKey 必须配 `CONFIG_ENCRYPTION_KEY`**：不配就禁止保存密钥（不降级成明文）；
  配了之后**不能换**，换了对不上的旧密文解不开（会降级到平台默认凭据并告警）
- **租户可填 LLM Base URL**，生产默认禁止指向内网 / 回环 / 云元数据地址（SSRF 防护）；
  要指自建局域网网关设 `CONFIG_ALLOW_PRIVATE_LLM_ENDPOINT=true`
- **租户可配的只有「安全/成本边界」之外的项**：加密密钥、SSRF 开关、上下文总预算、
  SSE 心跳留在服务端 `.env`；分界表见 [12-c](./docs/12-c-需求-管理员可配置.md) §C4
- **通用配置页收了 `.env` 里所有适合租户级的项**（**23 项 / 7 个分类**：知识库 5 · 成本 6 ·
  模型 2 · 安全 1 · 记忆 6 · **首页 2** · 提示词 1）；
  ⚠️ **其中 `prompt_version` 是隐藏的**（`hidden: true`，通用配置页不露出，
  由「提示词配置」页管理）—— 所以**页面上露出来的是 22 项**；
  加密密钥、SSRF 开关、采样参数（已在模型条目里）、
  传输层与内部估算参数**留在 `.env`**（重排的端点 / 凭据 / 模型也留在 `.env`，
  租户手里只有一个开关 `rerank_enabled`）
- **通用配置页的元信息在代码里**（`SETTINGS_REGISTRY`），`tenant_settings` 表只存租户改过的值
- **系统提示词必须走 `system` 参数**（塞进 messages 的 system 角色会被智谱 400）
- **提示词缓存开关在智谱上实测不生效**（`cache_read_tokens` 恒为 0，原因见 [06](./docs/06-大模型与Embedding.md) §6.4）
- **D 类的四个已知边界**（详见 [12-d](./docs/12-d-需求-运维稳定.md) §D3-§D5）：
  - **输出审核受 SSE 限制**：回答逐字发出去收不回来，后端保证「原文不落库 + 前端换文案」，
    做不到「一个字节都不发给浏览器」
  - **超预算默认只告警不拦截**（`.env` 的 `COST_BUDGET_BLOCK=true` 才拦）；
    **限流与成本累计都是进程内状态**，多实例部署时上限会放大到实例数倍
  - ✅ **LLM 调用重试（指数退避 + 抖动）已做**（2026-10-25 · `src/lib/retry.ts`）：
    AI SDK 自带的是指数退避、**没有抖动** —— 上游挂着时所有并发请求在同一毫秒
    一起重试，把刚要恢复的上游再打死一次（惊群）。本层用**全抖动**
    （`random(0, min(cap, base * factor^n))`），尊重 `Retry-After` 头，
    包住**非流式的** LLM 调用（流式中途失败已经吐了一半，重来会吐两遍）
  - **熔断是进程内状态**（2026-10-25 补的，`src/lib/circuit-breaker.ts`）：
    多实例部署时每个实例各断各的 —— 熔断是尽力而为的降级，断错了顶多多拒一会儿，
    不影响数据正确性，跟限流同一个取舍
- **页面级 e2e 层要单独装浏览器**：`yarn test:e2e` 用 Playwright，
  换机器第一次跑要先 `npx playwright install chromium`（约 100MB 下载）。
  它跟 vitest 用**同一个数据库**（.env 里那个），别拿生产库跑
- ✅ **2026-10-26 全量测试跑通**（数据库恢复连通后）：
  `yarn typecheck` ✅ · `yarn test`（unit + integration）**84 个文件 / 963 项通过**
  （13 项跳过）· `yarn test:e2e` **23 项通过**。
  ⚠️ **这之前集成层和 e2e 层在本机从没跑过** —— 那一大段「B5 / B6 / C3 靠集成测试兜底」
  的说法当时是**没被验证过的**。现在验证过了
- **测试基建的坑修了两次才真修好**（2026-10-26）：
  `vitest 5` 把 `pool` / `maxWorkers` / **`fileParallelism`** 全挪到了**顶层**，
  写在 `test:` 里**会被静默忽略**（不报错、不生效）——
  解析代码读的是顶层 `options.fileParallelism`，拿不到就回落到默认值 `true`。
  - 坑 ①：原来写的 `poolOptions.forks.singleFork` —— vitest 5 删了这个选项
  - 坑 ②：换成 `test.fileParallelism: false` —— **在 vitest 5 上同样不生效**
  - ✅ 现在的开关在 `vitest.config.ts` 的**顶层**（跟 `pool` 并排）
  - **症状**：`tests/integration/admin-audit.test.ts` 的「翻页拿到不同的行」偶发失败 ——
    另一个测试文件在两次翻页请求之间往 `audit_logs` 插了新行，
    offset 分页整体错位 → 两页重叠一行。
    （2026-10-26 全量回归时撞上；靠「看 audit_logs 的写入 id 顺序还交不交错」定位的）
  - ⚠️ **以后改 vitest 配置先确认选项在哪一层**：顶层选项挪进 `test:` 不会报错，
    只会悄悄不生效
- **`yarn lint` 跑不起来**（既有环境问题，不是代码问题）：`typescript-eslint` 不支持
  TypeScript 7.0，eslint 在**加载配置阶段**就报错退出，还没开始扫文件。
  改 `yarn typecheck` 当静态检查（这个是好的）

**未交付部分**：你正在重新思考中，由你口头告诉 AI 工程师下一步要做什么、用什么技术、按什么顺序。

---

## 2. 文档结构

参考用，AI 工程师按需打开，不强制阅读顺序。

> 当前 docs/ 下 **28 份主题文档**（编号 01–13，含子文档），加根目录 2 份入口（README / 本文件）。

| 编号     | 路径                                                                       | 用途                       |
| -------- | -------------------------------------------------------------------------- | -------------------------- |
| README   | [README.md](./README.md)                                                    | 项目入口 + 文档目录 + 阅读顺序 |
| AGENTS   | [AGENTS.md](./AGENTS.md)（本文件）                                          | AI 工程师简明操作手册       |
| 01       | [01-需求与场景.md](./docs/01-需求与场景.md)                                 | 业务场景、用户角色、3 层登录 |
| 02       | [02-系统架构与目录.md](./docs/02-系统架构与目录.md)                         | 架构图、数据流、目录结构   |
| 03-a     | [03-a-技术栈-工程化规范.md](./docs/03-a-技术栈-工程化规范.md)               | Node / TS / ESLint / Vitest |
| 03-b     | [03-b-技术栈-后端栈.md](./docs/03-b-技术栈-后端栈.md)                       | Koa / Vercel AI SDK / Sequelize |
| 03-c     | [03-c-技术栈-前端栈.md](./docs/03-c-技术栈-前端栈.md)                       | Vite / React / AntD / 路由 |
| 04-a     | [04-a-ui-总则布局与菜单.md](./docs/04-a-ui-总则布局与菜单.md)               | 设计总则 / 整体布局 / 菜单  |
| 04-b     | [04-b-ui-登录与聊天挂件.md](./docs/04-b-ui-登录与聊天挂件.md)               | 3 个登录页 + 聊天挂件       |
| 04-c     | [04-c-ui-后台管理页面.md](./docs/04-c-ui-后台管理页面.md)                   | 租户后台 18 个页面         |
| 04-d     | [04-d-ui-系统级与公共组件.md](./docs/04-d-ui-系统级与公共组件.md)           | SaaS 平台方页面 / 公共组件 |
| 05-a     | [05-a-数据模型-mysql.md](./docs/05-a-数据模型-mysql.md)                     | MySQL 核心表 DDL（已落地 24 张）           |
| 05-b     | [05-b-数据模型-qdrant.md](./docs/05-b-数据模型-qdrant.md)                   | Qdrant Collection 设计     |
| 06       | [06-大模型与Embedding.md](./docs/06-大模型与Embedding.md)                   | Vercel AI SDK / 模型 / 密钥 |
| 07-a     | [07-a-模块-llm与prompt.md](./docs/07-a-模块-llm与prompt.md)                 | 24 模块 01-04              |
| 07-b     | [07-b-模块-工具与agent.md](./docs/07-b-模块-工具与agent.md)                 | 24 模块 05-07              |
| 07-c     | [07-c-模块-rag记忆状态协议.md](./docs/07-c-模块-rag记忆状态协议.md)         | 24 模块 08-12              |
| 07-d     | [07-d-模块-框架与多代理.md](./docs/07-d-模块-框架与多代理.md)               | 24 模块 13-15              |
| 07-e     | [07-e-模块-评测观测可靠性.md](./docs/07-e-模块-评测观测可靠性.md)           | 24 模块 17-19              |
| 07-f     | [07-f-模块-安全与全栈.md](./docs/07-f-模块-安全与全栈.md)                   | 24 模块 20-23              |
| 08       | [08-评测方案.md](./docs/08-评测方案.md)                                     | 评测集 + LLM-as-Judge      |
| 09       | [09-观测方案.md](./docs/09-观测方案.md)                                     | 自建 trace / Pino / 告警   |
| 10       | [10-安全方案.md](./docs/10-安全方案.md)                                     | 注入检测 / 鉴权 / 限流     |
| 11       | [11-部署运维与成本.md](./docs/11-部署运维与成本.md)                         | 本地启动 + 备份 + 故障排查 |
| 12-a     | [12-a-需求-多租户与登录.md](./docs/12-a-需求-多租户与登录.md)               | A 类需求：多租户 + 登录    |
| 12-b     | [12-b-需求-ai对话能力.md](./docs/12-b-需求-ai对话能力.md)                   | B 类需求：AI 对话能力      |
| 12-c     | [12-c-需求-管理员可配置.md](./docs/12-c-需求-管理员可配置.md)               | C 类需求：管理员可配置     |
| 12-d     | [12-d-需求-运维稳定.md](./docs/12-d-需求-运维稳定.md)                       | D 类需求：运维稳定         |
| 12-e     | [12-e-需求-业务接入与平台运营.md](./docs/12-e-需求-业务接入与平台运营.md)   | E + F 类需求 + 双索引      |
| 13       | [13-扩展指南.md](./docs/13-扩展指南.md)                                     | 扩展指南 + 变更同步规则   |

---

## 3. 协作模式（你派活，AI 执行）

### 3.1 你（用户）怎么派活

**口头给指令**，AI 工程师照做。常见模式：

- "实现 / 改 X" → 写代码 + 同步改文档
- "加新需求 XX" → 改 12 → 改相关文档 → 改代码
- "换 X 技术为 Y" → 改 03 / 06 → 改代码
- "加 / 改 UI 页面" → 改 04 系列 → 改代码
- "回退 / 重做 X" → 删 / 改相关代码 + 文档

**不派活时**：AI 工程师不主动挑任务、不主动加功能、不主动换技术。

### 3.2 AI 工程师怎么响应

**默认行为**（轻量）：

1. 先听你的指令，不抢答
2. 涉及多个文档 / 多步改动时，先列出方案再动手
3. 不确定的事情 → 直接问你，不要自己拍板
4. 改完代码 → 停服务 + 跑相关测试 + 列出发现 / 留下的问题（HIGH → MEDIUM → LOW），然后**停下来等你的下一步指令**

**AI 工程师会主动问的情况**：

- 需求边界 / 歧义 / 没规定但实际会触发的场景
- 技术选型 / 库选型 / 框架版本
- 表结构变更（新增 / 改字段 / 删字段）
- 跨子系统影响（动到 2+ 个文档 / 模块）
- 涉及删除 / 重做既有代码
- 涉及「未在 12 里的新功能」

### 3.3 文档 vs 口头指令的优先级

- **口头指令 > 文档**：你一句话就能改文档原写的内容
- **改代码前** → 看一下对应文档作为参考
- **改代码后** → 文档是否要同步更新（如果你要求同步，AI 照办；如果你说"先不动文档"，AI 也会照办并在汇报时点出文档脱节）

---

## 4. AI 工程师的默认行为（轻量版）

### 4.1 改完代码后

- **停服务**：如果本次改动可能影响运行中的进程，先 `kill` 残留进程 + 确认端口释放（`lsof -i :<port>` 验证）。防止「代码改了但服务没重启 → 看起来没生效」
- **跑相关测试**：根据改动范围选择（一个 it / 一个 .test.ts → 跑那一个；middleware / 基建 → 跑全套；改前端 .tsx 不动 API → 只跑 `yarn typecheck`）
- **列问题**：按严重程度（**HIGH → MEDIUM → LOW**）汇报发现 / 留下的问题，至少覆盖：
  - 功能漏洞、安全、性能、向后兼容、UX、代码质量、文档脱节、依赖边界
- **停下来**：汇报完后不自动接着修，等你的下一步指令（修 / 接受 / 不动）

### 4.2 涉及数据库迁移

- 改了 `src/migrations/*.ts` 或新增了 Sequelize 字段 → 跑 `yarn migrate` 让真实 MySQL 跟上
- `package.json` 的 `dev:backend` 已配置 `yarn migrate && tsx watch src/server.ts`，起服务时会自动跑迁移（umzp 只跑 pending）
- 生产 `yarn start` 不自动跑迁移——DBA 走 `yarn migrate` + 灰度
- 改了表后报 `Unknown column 'xxx' in 'field list'` → 99% 是没跑 migrate，跑一下就行
- 加了新 model 但没在 `src/db.ts` 的 `addModels([...])` 注册 → 第一次 `.findAll()` 才崩

### 4.3 涉及环境变量（`.env` / `.env.example`）

这两个文件是**一份东西的两副面孔**：同一组 key、同一顺序、同一段注释，**只有值不同**。

|                             | `.env`（gitignored）               | `.env.example`（进 git）        |
| ---------------------------- | ---------------------------------- | ------------------------------- |
| 密钥（`*_API_KEY` / `*_PASSWORD` / `*_SECRET`） | 写真值                  | **留空**                        |
| 其他配置                     | 本地默认，dev 用远程基础设施时可 override | 本地默认（localhost / 默认 model id） |

**「哪个 key 该存在、哪个该删」的唯一依据是 `src/config.ts` 的 `envSchema`** ——
只有它读到的变量才算数。判断顺序：

1. `envSchema` 里有 → **两个文件都必须有**（同一个 section、同一位置）
2. `envSchema` 里没有 → **两个文件都不能有**（那是**死 key**，代码已经不读了 → 删掉）
3. 例外只有 **7 个**，清单在 `scripts/env-contract.ts` 的 `OPTIONAL_ENV_KEYS`
   （6 个搬到租户后台的 `CHAT_*` + `QDRANT_COLLECTION`）—— 别往里加东西

**按改动类型处置**：

- 往 `envSchema` 加一个 key → **`.env` 和 `.env.example` 都加**（同一个 section、同一位置）
- 从 `envSchema` 删一个 key → **两个文件都删**
- 只改值（换 provider / 换远程地址）→ **只动 `.env`**（`.env` 是本地真值，`.env.example` 保持本地默认）

**改完跑一次同步**（`.env.example` 是结构模板，`.env` 是「模板结构 + 本地真值」）：

```bash
yarn env:sync
```

**提交前跑一次校验**（只读不写，有问题退出码 1）：

```bash
yarn env:check
```

⚠️ **`yarn env:sync` 只自动修「模板说了算」的那部分**（`.env` 缺 key → 用模板值补；顺序/注释 → 按模板重排）。
下面三类**只报告不自动改**，因为要人拍板：

- **死 key**（文件里有、`envSchema` 里没有）→ 问「代码是真不要了，还是只是没走 `config.ts`？」
- **漏配**（`envSchema` 里有、文件里没有）→ 补进 `.env.example` 对应的 section
- **`.env` 有、模板没有的 key** → 问「是死 key 该删，还是模板漏了这一节该补？」

**兜底**：`tests/unit/env-consistency.test.ts` 守着同一套不变量 —— key 集合 / 顺序 / 注释结构一致、
两边都不许有 `envSchema` 之外的死 key、`envSchema` 里的 key 不许漏（7 个例外除外）、
`.env.example` 的 secret 行不许有真值。
⚠️ **改了 `src/config.ts` 的 `envSchema` 而忘了改这两个文件，这个测试会红** —— 那是它该做的。
（`.env` 是 gitignored 的本地文件，CI 上不存在 → 涉及 `.env` 的那几条断言在 CI 上自动跳过，
但 `.env.example` 那几条永远跑。）

⚠️ **踩过的坑（2026-10-27）**：这两个文件各漂了半年没人管 —— `.env` 少 6 个 key
（`TENANT_SCOPE_ENFORCE` / 熔断三项 / 记忆相关性两项，是 2026-10-26 那批功能上线时
**只改了 `.env.example` 忘了改 `.env`**），`.env` 还多一个 `SECURITY_PII_MASK_ENABLED`
（**死 key** —— 脱敏开关 2026-10-26 就从代码里摘掉了，文件里的行还留着、注释还写着
「建议一直开着」）。`scripts/sync-env.ts` 早就在仓库里，但**从没被跑过**，
而且它当年会把 `.env` 独有的 key 追加到文件末尾、还会把 dev 的远程地址抄进进 git 的模板 ——
所以它本身也修了（现在遇到结构漂移直接报错退出）。

---

## 5. AI 工程师不主动做的事

> 这些是「默认不主动」，不是「禁止」。如果你明确要做，AI 工程师会做。

- 不主动挑需求 / 加新功能
- 不主动换技术栈 / 升级依赖大版本
- 不主动重构既有代码
- 不主动跑「文档 ↔ 代码对照验证」（参考 [13-扩展指南.md §13.8.3](./docs/13-扩展指南.md)）
- 不主动写未决定的事到任何文档
- 不主动写「待定」「待补充」占位文字
- 不主动在 12 之外的文件重复需求清单

---

## 6. 不确定时怎么办

**直接问，不要自己拍板**。具体场景：

- 需求边界 / 歧义
- 技术选型（库版本、替代方案）
- 表结构变更
- 跨子系统影响
- 涉及删除既有文件
- 涉及「未在 12 里的新功能」

---

## 7. 第一次接手的标准操作（参考）

如果你刚被派来，可以按这个顺序熟悉项目（不强制）：

1. 读 AGENTS.md（你现在在读）
2. 读 README.md（项目索引）
3. 读 12-需求技术对照表（了解需求池）
4. 打开 02-系统架构与目录.md（看架构图）
5. 打开 03-技术栈与规范（确认技术栈）
6. 等用户的口头指令

---

> **一句话**：
> 文档是「参考」。你的口头指令是「命令」。AI 工程师听你派活。