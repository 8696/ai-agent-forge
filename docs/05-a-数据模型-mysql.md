# 05-a · 数据模型 · MySQL

> **本文件是 `05-数据模型.md` 的 §5.1-§5.5 节**（原主文件已拆分为 05-a / 05-b 两份）。本份负责**MySQL 核心表的 DDL + 索引策略 + 数据量估算 + 备份 + 迁移管理**。
> 向量库 Qdrant 部分见 `05-b-数据模型-qdrant.md`。
>
> **已落地 24 张表**（`src/models/` 下有对应 Sequelize 模型）：
> `tenants` / `users` / `system_users` / `api_keys` / `documents` / `sessions` / `messages` /
> `prompt_versions` / `tenant_models` / `tenant_settings` / `audit_logs` / `cost_logs` /
> `traces` / `spans` / `evaluation_datasets` / `evaluation_items` / `evaluation_runs` /
> `evaluation_results` / **`user_memories`**（2026-10-24 落地，B4 用户长期记忆，迁移 `017`）/
> **`tools`** / **`tool_call_logs`**（2026-10-25 落地，B3 工具调用 + C2 工具管理）/
> **`missions`**（2026-10-26 落地，B5 状态机工作流，迁移 `028`）/
> **`agent_runs`** / **`agent_steps`**（2026-10-26 落地，B6 多代理共享状态，迁移 `032`）。
> 各表 DDL 见下方 §5.1，定位见 [12-b](./12-b-需求-ai对话能力.md) §B3 / §B5 / §B6。

MySQL 8.0，字符集 `utf8mb4_unicode_ci`。所有时间字段用 `DATETIME(6)`（微秒精度，便于 trace 分析），主键统一 `VARCHAR(36)`（UUID）。

> **字符集 / 存储引擎由迁移 `027-normalize-charset` 显式规范**（把数据库和所有表统一成
> `utf8mb4_unicode_ci` + `InnoDB`）—— **不再依赖 MySQL 服务器的默认配置**。
> 以前建表走 umzug 迁移、迁移本身不指定 charset / engine，实际继承的是
> 服务器（或数据库）的默认值；换台机器、换个 `my.cnf` 就可能建出 `utf8mb3` 的表，
> 中文排序规则也跟着变。现在这一层由迁移自己钉死。

## 5.1 核心表

### 租户表（tenants）

```sql
CREATE TABLE tenants (
  id VARCHAR(36) PRIMARY KEY COMMENT 'UUID',
  code VARCHAR(32) NOT NULL UNIQUE COMMENT '租户号，全局唯一；登录 / 挂件 URL 用（例：acme-corp）',
  name VARCHAR(200) NOT NULL COMMENT '租户显示名',
  plan ENUM('free', 'pro', 'enterprise') DEFAULT 'free' COMMENT '套餐',
  settings JSON COMMENT '租户级配置（prompt_version / model / 限额）',
  api_key_hash VARCHAR(255) COMMENT '租户 API 密钥 bcrypt hash',
  status ENUM('active', 'disabled') DEFAULT 'active' COMMENT '租户状态；F2 配套；disabled 禁止 admin/customer 登录',
  expires_at DATETIME(6) NULL COMMENT '到期时间；F2 配套；NULL = 永不过期；到期后禁止 admin/customer 登录',
  created_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) COMMENT '创建时间',
  updated_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6) COMMENT '更新时间',
  INDEX idx_code (code),
  INDEX idx_plan (plan),
  INDEX idx_status_expires (status, expires_at) COMMENT 'F2 配套：登录按 (status, expires_at) 复合索引过滤'
) COMMENT '租户主表';
```

> **code 字段是登录和挂件 URL 的入口**：邮箱 + 密码 + 租户号 三件套才能登；缺租户号则无法区分跨租户的同名邮箱。
>
> **status / expires_at（F2 字段语义）**：`status='active'` 且 `expires_at` 未到（NULL 视为永远不过）才允许 `admin/login` + `customer/login`。任一条件不满足 → 401「租户不可用」（**响应体跟「邮箱或密码错」完全一致**，防账号枚举）。`code='system'` 的初始租户禁止被禁用（防 SaaS 平台方自锁）。

### 用户表（users）

```sql
CREATE TABLE users (
  id VARCHAR(36) PRIMARY KEY COMMENT 'UUID',
  tenant_id VARCHAR(36) NOT NULL COMMENT '所属租户（冗余存；查询时强制加 where 过滤）',
  email VARCHAR(255) NOT NULL COMMENT '登录邮箱；同租户内唯一',
  password_hash VARCHAR(255) COMMENT 'bcrypt hash（cost=12）',
  -- 角色：`admin` 后台管理员 / `agent` 后台客服坐席 / `customer` 前台用户
  -- 后台用户只能 admin / agent；前台用户一律 customer
  role ENUM('admin', 'agent', 'customer') NOT NULL COMMENT '3 个角色；不做权限矩阵',
  preferences JSON COMMENT '用户偏好（长期记忆）',
  must_change_password BOOLEAN DEFAULT FALSE COMMENT '首次登录强制改密码',
  failed_login_count INT DEFAULT 0 COMMENT '登录失败计数（防暴力）',
  locked_until DATETIME(6) NULL COMMENT '账号锁定截止时间；NULL 不锁定',
  last_login_at DATETIME(6) NULL COMMENT '最后登录时间',
  created_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) COMMENT '创建时间',
  updated_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6) COMMENT '更新时间',
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  UNIQUE KEY uk_email_per_tenant (email, tenant_id),
  INDEX idx_tenant_role (tenant_id, role)
) COMMENT '用户表（含后台 + 前台）';
```

### 对话会话表（sessions）

```sql
CREATE TABLE sessions (
  id VARCHAR(36) PRIMARY KEY COMMENT 'UUID',
  tenant_id VARCHAR(36) NOT NULL COMMENT '所属租户',
  user_id VARCHAR(36) COMMENT '前台用户 ID；匿名访问（公开挂件）为 NULL',
  channel ENUM('web', 'widget', 'email', 'api') NOT NULL COMMENT '接入渠道',
  status ENUM('active', 'closed', 'transferred') DEFAULT 'active' COMMENT '会话状态',
  title VARCHAR(200) COMMENT '第一条用户消息的前 20 字（自动生成）',
  summary TEXT COMMENT '摘要压缩后的内容（超长会话用）',
  metadata JSON COMMENT '渠道 / 来源 / 客户端信息',
  started_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) COMMENT '开始时间',
  ended_at DATETIME(6) COMMENT '结束时间（NULL 表示进行中）',
  INDEX idx_tenant_started (tenant_id, started_at),
  INDEX idx_user (user_id)
) COMMENT '对话会话表';
```

> **channel 的 `web`**：B1 落地时补的值 —— customer 登录后的前台聊天页（`/customer`）。
> 原 DDL 只有 `widget` / `email` / `api`，`widget` 留给下一轮的公开挂件（E1），
> `email` / `api` 是预留值，本期无入口。
>
> **`summary` 写的是会话摘要压缩的结果**（2026-10-24 起不再恒为 NULL）：
> 超长会话被裁掉的早期对话会调 LLM 折成一段摘要写进这里，下一轮再注入上下文。
> 配套的「摘要覆盖到哪条消息为止」边界标记在 `sessions.metadata.summary_boundary`。
> 详见 [12-b §B1.1](./12-b-需求-ai对话能力.md)。原来说的
> 本期超长对话靠 `src/lib/token-estimate.ts` 的 token 预算截断处理。

### 消息表（messages）

```sql
CREATE TABLE messages (
  id VARCHAR(36) PRIMARY KEY COMMENT 'UUID',
  session_id VARCHAR(36) NOT NULL COMMENT '所属会话',
  tenant_id VARCHAR(36) NOT NULL COMMENT '冗余存（方便按租户统计）',
  role ENUM('user', 'assistant', 'system', 'tool') NOT NULL COMMENT '消息角色',
  content MEDIUMTEXT COMMENT '消息正文（Markdown / 纯文本）',
  thinking_content MEDIUMTEXT COMMENT '思考模式的推理过程（与 content 分离）',
  tool_calls JSON COMMENT '工具调用的输入（role=tool 时为空）',
  tool_results JSON COMMENT '工具调用的输出',
  parts JSON COMMENT 'AI SDK 的 data part 数组（引用片段 / 工具调用记录）',
  usage JSON COMMENT '{ input_tokens, output_tokens, cache_read_tokens }',
  status ENUM('streaming', 'complete', 'failed', 'cancelled') DEFAULT 'complete' COMMENT '消息状态（流式用）',
  feedback TINYINT NULL COMMENT '用户反馈：1=点赞 / -1=点踩 / NULL=无',
  feedback_text VARCHAR(1000) NULL COMMENT '反馈文本（"答错 / 答偏 / 其他"）',
  feedback_at DATETIME(6) NULL COMMENT '反馈时间',
  trace_id VARCHAR(36) NULL COMMENT '关联到 traces（用于在 Trace 详情里看到这条消息）',
  created_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) COMMENT '消息时间',
  INDEX idx_session (session_id, created_at),
  INDEX idx_tenant (tenant_id, created_at),
  INDEX idx_trace (trace_id)
) COMMENT '聊天消息表';
```

> **建表迁移**：`src/migrations/009-create-sessions-messages.ts`（sessions + messages 一起建）。
>
> 这是一条**收敛迁移**：更早的 Step 6 实现建过同名的两张表（迁移记录 `008-create-sessions` /
> `009-create-messages` 仍在 `sequelize_meta` 里），那两张表的 `channel` 枚举里没有 `web`。
> Sequelize 的 `createTable` 会生成 `CREATE TABLE IF NOT EXISTS`，表在的时候**静默跳过**，
> 后续 `addIndex` 就会撞 `Duplicate key name`。所以 009 逐项判断再动手：
> 表不存在 → 建全；表存在 → 补缺列、补缺索引，并 `MODIFY` 把 `channel` 收敛到含 `web` 的定义
> （MySQL 不支持直接给 ENUM 追加值，只能 MODIFY）。
>
> ⚠️ **`tool_results` 曾经被重载，现在分开了**：
> DDL 原意是「工具调用的输出」，但 B1 需要把 AI SDK 的 `data-citations` / `data-status`
> 这些 data part 落库（否则刷新页面后历史回答的「来源」角标就丢了），
> 于是这一列被临时借用去装 `{ data_parts: [...] }` —— 两种语义混在一列里，前端要靠 key 猜。
>
> **2026-10-25（B3 工具调用落地时）已分开**：
>  - 新增 `parts JSON` 列 —— 装 data part 数组（引用片段 + 工具调用记录）
>  - `tool_results` 语义还给「真正的工具调用输出」
>  - 迁移 `023-messages-parts-column` 负责回填（实测搬了 74 行）并清空 `tool_results`
>
> 读写统一走 `src/services/chat.ts` 的 `readDataParts` / `extractDataParts`。
>
> **`status='streaming'` 的僵尸行**：assistant 消息在开流之前就先建行（正文为空），
> 流结束后回填。进程被 kill / OOM 会留下一批永远停在 `streaming` 的行，
> 读历史时由 `markStaleStreamingAsFailed()` 就地降级为 `failed`（5 分钟阈值）。

### 知识库文档表（documents）

```sql
CREATE TABLE documents (
  id VARCHAR(36) PRIMARY KEY COMMENT 'UUID',
  tenant_id VARCHAR(36) NOT NULL COMMENT '所属租户',
  title VARCHAR(500) NOT NULL COMMENT '文档标题（原始文件名）',
  source VARCHAR(500) COMMENT '本地存储路径（./data/uploads/{tenant_id}/xxx.pdf）',
  file_type ENUM('pdf', 'markdown', 'txt') COMMENT '文件类型',
  file_path VARCHAR(1000) COMMENT '完整磁盘路径（绝对路径）',
  status ENUM('uploaded', 'indexing', 'ready', 'failed') DEFAULT 'uploaded' COMMENT '索引状态',
  chunk_count INT DEFAULT 0 COMMENT '已分块的块数（索引完成后回填）',
  error_message VARCHAR(1000) COMMENT '最近一次索引失败的错误摘要（完整堆栈只进日志）',
  metadata JSON COMMENT '元数据（标签 / 部门 / 业务字段）',
  uploaded_by VARCHAR(36) COMMENT '上传者 user_id',
  uploaded_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) COMMENT '上传时间',
  INDEX idx_tenant_uploaded (tenant_id, uploaded_at),
  INDEX idx_status (status)
) COMMENT '知识库文档元数据表（向量存 Qdrant）';
```

> **建表迁移**：`src/migrations/007-create-documents.ts`。
> `008-converge-documents-schema.ts` 是配套的**收敛迁移** —— 开发库上可能已经有更早版本建的
> `documents` 表（字段更少），它逐列比对、缺哪补哪，保证新旧两种库都收敛到同一 schema。
> 收敛迁移 `down()` 不删列（删列丢数据且无法从旧脚本可靠重建），回滚走 `yarn migrate:undo` + 备份恢复。
>
> **`file_type` 没有 `'word'`**：2026-10-25 把 **DOCX 解析整个从需求里删掉**
> （上传格式只剩 PDF / Markdown / TXT，见 [01](./01-需求与场景.md) §1.5「不做 / Out of Scope」），
> 迁移 `021-alter-documents-file-type.ts` 把库里的列收窄成
> `ENUM('pdf','markdown','txt')`。上传白名单（`src/services/document-upload.ts`）
> 只放行这三种扩展名，传 `.docx` 返 400。

### 工具注册表（tools）

```sql
CREATE TABLE tools (
  id VARCHAR(36) PRIMARY KEY COMMENT 'UUID',
  tenant_id VARCHAR(36) NOT NULL COMMENT '所属租户',
  name VARCHAR(100) NOT NULL COMMENT '工具名（英文，调用时用）',
  description TEXT COMMENT '工具描述（给 LLM 看，决定是否调用）',
  type ENUM('builtin', 'http', 'mcp') DEFAULT 'builtin' COMMENT 'builtin=平台自带；http=租户自己的 HTTP 接口；mcp=外部 MCP 服务',
  config JSON COMMENT '配置：builtin=工具标识；http=url/method/headers/body_template/parameters；mcp=mcp_server_url/mcp_server_path/headers',
  enabled BOOLEAN DEFAULT TRUE COMMENT '是否启用',
  requires_confirmation BOOLEAN DEFAULT FALSE COMMENT '是否敏感操作（true 时模型调用它要先让用户确认）',
  created_by VARCHAR(36) COMMENT '注册人 user id',
  created_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) COMMENT '创建时间',
  updated_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6) COMMENT '更新时间',
  UNIQUE INDEX uk_tenant_name (tenant_id, name),
  INDEX idx_tenant_enabled (tenant_id, enabled)
) COMMENT '工具注册表（B3 工具调用 / C2 工具管理）';
```

> **建表迁移**：`src/migrations/022-create-tools.ts`（2026-10-25 落地）。
>
> **实现放代码，注册放数据库**：`config.builtin` 指向 `src/tools/builtin/registry.ts` 里的实现，
> `description` 是**给模型看的**（租户能改 → 能调教模型调不调它）。
>
> ⚠️ **`requires_confirmation` / `created_by` / `updated_at` 三列是落地时补的**
> （原 DDL 没有）：敏感标记是 HITL 的入口；`created_by` 跟其他 admin 可写表一样记操作人；
> `updated_at` 是因为 PATCH 之后要知道最后改于何时（原 DDL 只有 `created_at`）。

> ⚠️ **2026-10-25 修正**（原设计稿的三个错，已在上方改掉）：
>
> - **漏了 `tenant_id` 列**：原 DDL 只有 `INDEX idx_tenant_name (tenant_id, name)`，
>   却没有 `tenant_id` 这个列 —— 按原样建表会直接报 MySQL 1072
>   （Key column 'tenant_id' doesn't exist in table）。
> - **索引不是唯一的**：C2 的验收要求「工具名在租户内唯一，重名返回 400」，
>   原 `INDEX` 不保证唯一 → 改成 `UNIQUE INDEX uk_tenant_name (tenant_id, name)`，
>   唯一性由数据库兜（应用层仍要 catch 唯一键冲突返 400）。
> - **`type` 枚举少了一类**：原本只有 `builtin` / `mcp`。
>   `builtin` 的内置工具集本期不定，`mcp` 又要求客户那边跑 MCP server ——
>   **中间那类最常见的「租户自己有 REST 接口」无处可落**。
>   现在补上 `http` 类型（`config` 装 `url` / `method` / `headers` / `body_template`）。
>
> **落地状态（2026-10-25）**：本轮**只开放 `builtin`**（6 个内置 mock 工具，
> 实现在 `src/tools/builtin/`），`http` / `mcp` 端点层直接拒绝 —— 出网策略还没定。
>
> `type='http'` 的工具要**调租户自己的接口**，安全边界见下面的说明 ——
> 它跟「租户填 LLM Base URL」不是同一套策略，不能直接套用。

> ⚠️ **`type='http'` 的出网策略要单独定，不能照抄 LLM Base URL 那套**（2026-10-25 记下）：
>
> 现有的 SSRF 闸在 `src/lib/llm-endpoint.ts`（`checkLlmEndpoint` / `assertLlmEndpoint`），
> 生产默认**禁止回环 / 私网 / 链路本地 / 云元数据**（见 [12-c §C4](./12-c-需求-管理员可配置.md)）。
> 但 `http` 工具的**正常用法就是调租户自己的内网系统** ——
> ERP 在 `10.x`、工单系统在 `192.168.x`、自建服务在 `127.0.0.1`。
> 照搬那套策略会把**正当用途全挡掉**。
>
> 需要单独定的三件事（实现 B3/C2 时落）：
>
> 1. **云元数据地址永远禁**（`169.254.169.254` / `fd00:ec2::254`）——
>    这条没有例外，任何租户的任何工具都不许碰
> 2. **RFC1918 私网段按租户开关放行**：给租户一个独立的
>    「允许工具访问内网」开关（跟 `CONFIG_ALLOW_PRIVATE_LLM_ENDPOINT` 分开，
>    别共用一个 —— LLM 端点能连内网，不代表工具能连）
> 3. **出网前复查**：`url` 存的时候校验一次、**每次调用前再校验一次**
>    （存的时候域名解析出的 IP 可能跟调用时不一样，DNS 会被改）
>
> `headers` 里的密钥走 AES-256-GCM 加密存储（复用 `src/lib/crypto.ts`），
> 接口**永不回明文**。

### 工具调用流水表（tool_call_logs）✅ B3 已落地 2026-10-25

```sql
CREATE TABLE tool_call_logs (
  id VARCHAR(36) PRIMARY KEY COMMENT 'UUID',
  tenant_id VARCHAR(36) NOT NULL COMMENT '所属租户',
  user_id VARCHAR(36) NULL COMMENT '触发调用的用户（匿名挂件 / 对外 API 为空）',
  session_id VARCHAR(36) NULL COMMENT '所属会话',
  message_id VARCHAR(36) NULL COMMENT '关联的 assistant 消息 id',
  tool_call_id VARCHAR(64) NOT NULL COMMENT 'SDK 分配的调用 id',
  tool_name VARCHAR(100) NOT NULL COMMENT '注册名（模型调用的就是这个名字）',
  builtin VARCHAR(64) NULL COMMENT '内置实现 key',
  status ENUM('ok', 'error', 'timeout', 'awaiting_confirmation') DEFAULT 'ok' COMMENT 'ok=成功 / error=抛错 / timeout=超时 / awaiting_confirmation=待用户确认（未执行）',
  args JSON COMMENT '请求参数（模型给的入参）',
  output JSON COMMENT '响应参数（工具的返回值）',
  error VARCHAR(1000) NULL COMMENT '失败原因（成功时为空）',
  duration_ms INT DEFAULT 0 COMMENT '耗时（毫秒）',
  trace_id VARCHAR(36) NULL COMMENT '关联的 trace',
  created_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) COMMENT '调用时间',
  INDEX idx_tenant_created (tenant_id, created_at),
  INDEX idx_tenant_tool (tenant_id, tool_name, created_at),
  INDEX idx_session (session_id)
) COMMENT '工具调用流水（B3 工具调用）';
```

> **建表迁移**：`src/migrations/024-create-tool-call-logs.ts`（2026-10-25）。
>
> **一行 = 一次工具调用**，带**请求参数**和**响应参数** —— 后台「工具调用记录」页读它。
>
> 工具调用记录本来就落在 `messages.parts` 的 `data-tool-call` part 里（含参数和结果），
> 但那是 **JSON 列**，没法按时间 / 工具 / 状态建索引 —— 分页翻页都得全表扫，
> 「只看失败的」「只看某个工具的」更做不了。要一个能筛的列表就得有正经的列。
>
> **写入路径**：工具执行包装层（`src/tools/execute.ts`）是所有工具调用的**唯一出口**，
> 每次调用结束都写一行 —— 不会漏记。⚠️ 写库失败只 warn，**不影响用户的对话**
> （观测是旁路，跟 trace 一个道理）。
>
> `awaiting_confirmation` 这一档是 HITL 闸门拦下的调用 —— 工具**没有真正执行**，
> 所以 `output` 是空的。

### 任务表（missions，工作流主表）✅ 已建表 2026-10-26（迁移 `028`）

> **建表迁移**：`src/migrations/028-create-missions.ts`
> **模型**：`src/models/Mission.ts`　**引擎**：`src/workflows/engine.ts`
> 需求见 [12-b §B5 / §B5.1](./12-b-需求-ai对话能力.md)。

```sql
CREATE TABLE missions (
  id VARCHAR(36) PRIMARY KEY COMMENT '任务 id（nanoid 21）',
  tenant_id VARCHAR(36) NOT NULL COMMENT '所属租户',
  session_id VARCHAR(36) COMMENT '触发的会话（后台任务为空）',
  user_id VARCHAR(36) COMMENT '触发者（匿名挂件 / 对外 API 为空）',
  type VARCHAR(100) NOT NULL COMMENT '流程类型（refund_request / modify_address / after_sale_ticket）',
  state ENUM('pending','running','awaiting_confirmation','completed','failed','cancelled') DEFAULT 'pending' COMMENT '任务状态机',
  is_sensitive BOOLEAN DEFAULT FALSE COMMENT '是否含敏感操作（true 需 HITL 确认）',
  current_step VARCHAR(100) COMMENT '当前节点 id（断点恢复靠它知道从哪继续）',
  approval_key VARCHAR(255) COMMENT '用户批准的那次工具调用（工具名:入参指纹）',
  context JSON COMMENT '流程收集到的中间数据（订单信息、优惠信息…）',
  result JSON COMMENT '流程最终结果',
  expires_at DATETIME(6) COMMENT '超时时间（过期 → cancelled）',
  created_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) COMMENT '创建时间',
  updated_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6) COMMENT '更新时间',
  INDEX idx_session (session_id),
  INDEX idx_tenant_state (tenant_id, state),
  INDEX idx_state_updated (state, updated_at),
  INDEX idx_missions_tenant_approval (tenant_id, approval_key),
  INDEX idx_missions_tenant_user (tenant_id, user_id, state)
) COMMENT '任务表（B5 状态机工作流）';
```

> ⚠️ **2026-10-26 相对 2026-10-25 预留版补了 5 列**（预留版只有 9 列）：
> `user_id`（找「这个用户还有哪些任务没结束」）、
> `current_step`（断点恢复要知道从哪个节点继续）、
> `approval_key`（批准/拒绝时定位到具体那条任务）、
> `expires_at`（超时自动取消），
> 以及 `idx_missions_tenant_approval` / `idx_missions_tenant_user` 两个索引。
>
> ⚠️ **`approval_key` 为什么要有索引**：用户点「确认执行」时，
> 后端要按「租户 + 会话 + 这次调用的审批键」找到那条任务并把它从
> `awaiting_confirmation` 转成 `running`。没索引就是全表扫。
>
> ⚠️ **`idx_state_updated` 改名了**：预留版叫 `idx_state`，
> 实际建表时按 `(state, updated_at)` 的组合命名，跟仓库里其他索引的命名习惯对齐。

#### 工具调用流水加了一档状态（迁移 `029`）

`tool_call_logs.status` 的 ENUM 加了 **`blocked`** ——
B5 工作流闸门的新拦截路径：「前置步骤没满足」（模型想直接提交退款，
但还没查过订单，闸门拦住并告诉它先查）。

它既不是 `awaiting_confirmation`（没人要点头），也不是 `rejected`（用户没拒绝），
也不是 `error`（不是失败）—— 是**流程约束**。混用任何一个都会让后台筛选失真。


### 评测集表（evaluation_datasets / evaluation_items）✅ D1 已落地 2026-10-24

> **落地实现**（迁移 `016-create-evaluation`）。跟初版设计稿的差异见下方说明。

```sql
CREATE TABLE evaluation_datasets (
  id VARCHAR(36) PRIMARY KEY COMMENT 'nanoid 21',
  tenant_id VARCHAR(36) NOT NULL COMMENT '所属租户',
  name VARCHAR(100) NOT NULL COMMENT '评测集名（如 "客服 V1"）',
  version VARCHAR(32) NOT NULL DEFAULT 'v1' COMMENT '版本（同名多次上传递增）',
  description VARCHAR(500) COMMENT '备注',
  item_count INT NOT NULL DEFAULT 0 COMMENT '条目数',
  created_by VARCHAR(36) COMMENT '创建人',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) COMMENT '上传时间',
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) COMMENT '更新时间',
  INDEX idx_eval_datasets_tenant_created (tenant_id, created_at)
) COMMENT '评测集主表';

CREATE TABLE evaluation_items (
  id VARCHAR(36) PRIMARY KEY COMMENT 'nanoid 21',
  dataset_id VARCHAR(36) NOT NULL COMMENT '所属评测集',
  tenant_id VARCHAR(36) NOT NULL COMMENT '所属租户（冗余一份，方便按租户直接查）',
  question TEXT NOT NULL COMMENT '测试问题',
  reference_answer TEXT COMMENT '参考答案（人工写的；可空）',
  scenario VARCHAR(64) COMMENT '场景分类（退款 / 改地址 / 闲聊）',
  difficulty VARCHAR(16) COMMENT '难度：easy / medium / hard（其它值当未标注）',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) COMMENT '创建时间',
  INDEX idx_eval_items_dataset (dataset_id)
) COMMENT '评测集条目';
```

> **与初版设计稿的差异**：
> - `version` 从 `INT` 改成 `VARCHAR(32)`：设计稿的 `INT` + `UNIQUE KEY (tenant_id, name, version)`
>   意味着「同名同版本只能有一条」，但运营的实际用法是**每次上传都递增版本**
>   （`v1` / `v2` / …），用字符串更直观，也不需要强约束卡住误操作
> - `id` 用 `VARCHAR(36)` 而不是 `BIGINT AUTO_INCREMENT`：跟库里其它业务表（sessions / messages /
>   prompt_versions）保持一致，前端拿到的 id 直接能当 URL 片段用
> - `evaluation_items` 冗余了一份 `tenant_id`：不 join 就能按租户查条目
> - `difficulty` 用 `VARCHAR(16)` 而不是 `ENUM`：评测集是租户自己的东西，
>   多一个不该被数据库挡住；读取时 `normalizeDifficulty()` 只认三个值，别的当未标注
> - `source`（原始 JSONL 文件名）没做：前端是把 JSONL 读进文本框再提交，
>   服务端拿不到「文件名」这个概念

### 评测运行表（evaluation_runs）✅ D1 已落地 2026-10-24

```sql
CREATE TABLE evaluation_runs (
  id VARCHAR(36) PRIMARY KEY COMMENT 'nanoid 21',
  tenant_id VARCHAR(36) NOT NULL COMMENT '所属租户',
  dataset_id VARCHAR(36) NOT NULL COMMENT '使用的评测集',
  dataset_name VARCHAR(100) COMMENT '评测集名称快照（评测集改名 / 删除后还能看）',
  prompt_version VARCHAR(64) COMMENT '跑评测时的提示词版本（追变更用的）',
  model VARCHAR(100) COMMENT '跑评测用的模型',
  provider VARCHAR(32) COMMENT 'provider',
  status VARCHAR(16) NOT NULL DEFAULT 'running' COMMENT 'running / completed / failed',
  total_items INT NOT NULL DEFAULT 0 COMMENT '总条目数',
  completed_items INT NOT NULL DEFAULT 0 COMMENT '已完成数（跑批中显示进度）',
  accuracy FLOAT COMMENT '准确性平均分（0~5）',
  completeness FLOAT COMMENT '完整性平均分（0~5）',
  style FLOAT COMMENT '风格平均分（0~5）',
  safety FLOAT COMMENT '安全平均分（0~5）',
  total_score FLOAT COMMENT '四维平均（0~5）—— 趋势对比看这个',
  total_tokens INT NOT NULL DEFAULT 0 COMMENT '本次跑批消耗的总 token（生成 + 裁判）',
  total_cost DECIMAL(12,6) NOT NULL DEFAULT 0 COMMENT '本次评测总花费（USD，估算值）',
  error_message VARCHAR(500) COMMENT '失败原因',
  started_at DATETIME(6) NOT NULL COMMENT '开始时间',
  finished_at DATETIME(6) COMMENT '结束时间',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) COMMENT '创建时间',
  INDEX idx_eval_runs_tenant_created (tenant_id, created_at),
  INDEX idx_eval_runs_dataset_created (dataset_id, created_at)
) COMMENT '评测运行（每次跑一次一条）';
```

> **与初版设计稿的差异**：
> - `status` 用 `VARCHAR(16)` 而不是 `ENUM`：跟库里的 `documents.status` / `messages.status` 一致
> - `avg_*` 四个字段改成 `accuracy` / `completeness` / `style` / `safety`：
>   「avg」这个前缀在字段名里是冗余的（表本身就是聚合结果）
> - 分数用 `FLOAT` 而不是 `DECIMAL(3,2)`：裁判的分是 0~5 的**整数**，
>   多条平均后可能是 4.333…，`DECIMAL(3,2)` 存不下
> - 额外加了 `total_score`（四维平均）、`total_tokens`、`provider`、`dataset_name` 快照
> - 没有 `queued` 状态：跑批是「建行即开跑」，不需要排队


### LLM 调用成本流水表（cost_logs · D3）

```sql
CREATE TABLE cost_logs (
  id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '自增 ID',
  tenant_id VARCHAR(36) NOT NULL COMMENT '所属租户',
  user_id VARCHAR(36) COMMENT '触发调用的用户',
  session_id VARCHAR(36) COMMENT '所属会话',
  message_id VARCHAR(36) COMMENT '关联的 assistant 消息 id',
  provider VARCHAR(32) COMMENT 'provider 标识（zhipu / minimax / ...）',
  model VARCHAR(100) COMMENT '实际使用的模型 id',
  input_tokens INT NOT NULL DEFAULT 0 COMMENT '输入 token',
  output_tokens INT NOT NULL DEFAULT 0 COMMENT '输出 token',
  cache_read_tokens INT NOT NULL DEFAULT 0 COMMENT '缓存命中 token',
  cache_write_tokens INT NOT NULL DEFAULT 0 COMMENT '缓存写入 token',
  total_tokens INT NOT NULL DEFAULT 0 COMMENT '合计 token（预算闸门按这个算）',
  cost DECIMAL(12,6) NOT NULL DEFAULT 0 COMMENT '估算花费（USD）；不在价格表里时为 0 = 未知',
  created_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) COMMENT '调用时间',
  INDEX idx_cost_logs_tenant_created (tenant_id, created_at),
  INDEX idx_cost_logs_session (session_id)
) COMMENT 'LLM 调用成本流水（一行一次调用）';
```

> **D3 配套**。`total_tokens` 是预算闸门的依据；`cost` 是按内置价格表估的
> （可用 `.env` 的 `COST_PRICE_TABLE` 覆盖），**只代表量级，不是账单金额**。

### 调用链路表（traces / spans）✅ D2 已落地 2026-10-24

> **落地实现**（迁移 `015-create-traces-spans`）。

```sql
CREATE TABLE traces (
  id VARCHAR(36) PRIMARY KEY COMMENT 'nanoid 21',
  tenant_id VARCHAR(36) NOT NULL COMMENT '所属租户',
  user_id VARCHAR(36) COMMENT '触发用户',
  session_id VARCHAR(36) COMMENT '所属会话',
  name VARCHAR(100) NOT NULL COMMENT 'trace 名（如 chat.message）',
  kind VARCHAR(32) NOT NULL DEFAULT 'chat' COMMENT 'chat / api / evaluation',
  status VARCHAR(16) NOT NULL DEFAULT 'success' COMMENT 'success / error',
  channel VARCHAR(32) COMMENT '接入渠道（web / widget / api）',
  provider VARCHAR(32) COMMENT 'LLM provider',
  model VARCHAR(100) COMMENT '实际使用的模型 id',
  input_tokens INT NOT NULL DEFAULT 0 COMMENT '输入 token',
  output_tokens INT NOT NULL DEFAULT 0 COMMENT '输出 token',
  cache_read_tokens INT NOT NULL DEFAULT 0 COMMENT '缓存读取 token',
  cache_write_tokens INT NOT NULL DEFAULT 0 COMMENT '缓存写入 token',
  total_tokens INT NOT NULL DEFAULT 0 COMMENT '合计 token',
  cost DECIMAL(12,6) NOT NULL DEFAULT 0 COMMENT '估算花费（USD）',
  duration_ms INT COMMENT '总耗时（毫秒）',
  error_message VARCHAR(500) COMMENT '失败原因（摘要，不记堆栈）',
  metadata JSON COMMENT '附加信息',
  started_at DATETIME(6) NOT NULL COMMENT '开始时间',
  ended_at DATETIME(6) COMMENT '结束时间',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) COMMENT '入库时间',
  INDEX idx_traces_tenant_started (tenant_id, started_at),
  INDEX idx_traces_tenant_status_started (tenant_id, status, started_at),
  INDEX idx_traces_session (session_id),
  INDEX idx_traces_user (user_id)
) COMMENT '一次对话/请求的调用链（D2 观测）';

CREATE TABLE spans (
  id VARCHAR(36) PRIMARY KEY COMMENT 'nanoid 21',
  trace_id VARCHAR(36) NOT NULL COMMENT '所属 trace',
  tenant_id VARCHAR(36) NOT NULL COMMENT '所属租户（冗余一份，方便按租户直接查）',
  parent_span_id VARCHAR(36) COMMENT '父 span（NULL = 直接挂在 trace 下）',
  name VARCHAR(100) NOT NULL COMMENT 'span 名（如 retrieval.search）',
  kind VARCHAR(32) NOT NULL DEFAULT 'step' COMMENT 'http / retrieval / llm / guard / cost / storage',
  status VARCHAR(16) NOT NULL DEFAULT 'success' COMMENT 'success / error',
  duration_ms INT COMMENT '耗时（毫秒）',
  input JSON COMMENT '入参摘要',
  output JSON COMMENT '出参摘要',
  error_message VARCHAR(500) COMMENT '失败原因（摘要）',
  started_at DATETIME(6) NOT NULL COMMENT '开始时间',
  ended_at DATETIME(6) COMMENT '结束时间',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) COMMENT '入库时间',
  INDEX idx_spans_trace (trace_id),
  INDEX idx_spans_tenant_started (tenant_id, started_at)
) COMMENT '调用链里的一步（D2 观测）';
```

> **与初版设计稿的差异**：
> - 主键用 `id`（不是 `trace_id` / `span_id`）：跟库里其它表一致，前端 id 直接当 URL 片段用
> - 时间字段用 `started_at` / `ended_at`（不是 `start_time` / `end_time`）：
>   跟 `sessions` 表一致
> - `status` 用 `VARCHAR(16)` + `success` / `error`（不是 `ENUM('ok','error')`）
> - `root_span_name` 改成 `name` + `kind`：trace 自己的名字（`chat.message`）
>   和类型分开，`kind` 用来区分 chat / api / evaluation
> - `spans` 的 `attributes` / `events` 两个 JSON 合成 `input` / `output`：
>   「这一步吃了什么 / 吐了什么」比「生命周期事件列表」更好读，
>   而且 `events` 那一层在 MVP 里没有实际用途
> - 额外加了 `channel` / `provider` / `model` / 缓存 token / `total_tokens` / `cost`：
>   成本分析页要按模型 / 渠道拆，trace 行自带这些就不用 join
> - **不加外键**：跟 `audit_logs` / `cost_logs` 一致；
>   trace 结束时在一个事务里把 trace + spans 一起写，不存在孤儿 span


### 审核日志表（audit_logs）

```sql
CREATE TABLE audit_logs (
  id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '自增 ID',
  tenant_id VARCHAR(36) NOT NULL COMMENT '所属租户（NULL 表示系统级日志）',
  user_id VARCHAR(36) COMMENT '触发操作的用户',
  action VARCHAR(100) NOT NULL COMMENT '操作类型（LOGIN / CREATE_USER / CONFIG_CHANGE 等）',
  resource_type VARCHAR(100) COMMENT '资源类型（user / document / settings）',
  resource_id VARCHAR(36) COMMENT '资源 ID',
  details JSON COMMENT '操作详情（改了什么 / 失败原因）',
  ip VARCHAR(45) COMMENT '客户端 IP（IPv6 最长 45 字符）',
  created_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) COMMENT '操作时间',
  INDEX idx_tenant_created (tenant_id, created_at)
) COMMENT '审核日志（所有关键操作）';
```

### 系统超级管理员表（system_users · 跨租户）

> **A2 配套**。SaaS 平台方自己的账号（建租户的那个）单独存这张表，**不与租户用户混在一起**——能跨租户操作。
> 没有 `tenant_id` 字段。

```sql
CREATE TABLE system_users (
  id VARCHAR(36) PRIMARY KEY COMMENT 'UUID',
  email VARCHAR(255) NOT NULL UNIQUE COMMENT '系统级管理员邮箱（唯一）',
  password_hash VARCHAR(255) NOT NULL COMMENT 'bcrypt hash',
  name VARCHAR(100) COMMENT '显示名',
  role ENUM('system') DEFAULT 'system' COMMENT '唯一角色：system（SaaS 平台方）',
  failed_login_count INT DEFAULT 0 COMMENT '登录失败计数',
  locked_until DATETIME(6) NULL COMMENT '账号锁定截止时间',
  last_login_at DATETIME(6) NULL COMMENT '最后登录时间',
  created_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) COMMENT '创建时间',
  updated_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6) COMMENT '更新时间'
) COMMENT '系统超级管理员（建租户）';
```

> 第一个 `system_users` 用 SQL 手工建（不需要 system_users 自己建自己的功能）。
>
> **注**：本系统不引入 `agent`（租户客服坐席）角色——AI 客服直接接待客户。`users.role` ENUM 仍保留 `('admin', 'agent', 'customer')` 是因为历史 schema 已存在，代码层面拒收 agent 登录。Step 13+ 决定要不要把 ENUM 收紧成 `('admin', 'customer')`。

### 租户 API 密钥表（api_keys · 外部系统接入）

> **E1 配套**。租户 admin 在后台「API 密钥」页生成 API Key，外部系统拿这个 Key 调 `/api/v1/public/chat`、`/api/v1/public/chat/stream`、`/api/v1/public/search` 等端点（**不是** `/api/v1/chat` —— 对外端点全在 `public` 命名空间下）。

```sql
CREATE TABLE api_keys (
  id VARCHAR(36) PRIMARY KEY COMMENT 'UUID',
  tenant_id VARCHAR(36) NOT NULL COMMENT '所属租户',
  name VARCHAR(100) NOT NULL COMMENT '租户自己起的名字（"生产环境 / 测试环境"）',
  key_prefix VARCHAR(10) NOT NULL COMMENT 'key 前 8 位（用于 UI 显示识别，不存完整 key）',
  key_hash VARCHAR(255) NOT NULL COMMENT '完整 key 的 bcrypt hash',
  key_sha256 CHAR(64) NULL COMMENT '完整 key 的 sha256（只用于索引定位；存量行为 NULL）',
  scope ENUM('read', 'write', 'admin') NOT NULL DEFAULT 'write' COMMENT '权限分级：read=只读（不能发起对话）/ write=可发起对话 / admin=知识库管理（可上传 / 删除本租户文档）',
  last_used_at DATETIME(6) NULL COMMENT '最后使用时间',
  expires_at DATETIME(6) NULL COMMENT '过期时间；NULL = 不过期',
  revoked_at DATETIME(6) NULL COMMENT '撤销时间（软删除）',
  created_by VARCHAR(36) NOT NULL COMMENT '哪个 admin 创建的',
  created_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) COMMENT '创建时间',
  INDEX idx_tenant (tenant_id, created_at),
  INDEX idx_prefix (tenant_id, key_prefix),
  UNIQUE INDEX idx_api_keys_sha256 (key_sha256)
) COMMENT '租户 API 密钥';
```

> 完整 key **只在创建时返回一次**（UI 上「复制」按钮），DB 只存 hash。丢了只能重新生成。
>
> **`scope` 列（迁移 `020-add-api-key-scope.ts`，2026-10-25 补）**：
> 规格里（[10-安全方案.md §10](./10-安全方案.md)）写着「API Key：每个租户一个，权限按 scope 分
> （只读 / 写入 / 管理员）」，但这张表**从来没有 scope 列** —— 一把 key 能调该租户的全部对外端点。
> 对外的 key 是**发到客户系统里**的，泄露一次就是「整租户的问答能力 + token 花费」全敞。
>
> | scope | 能做什么 |
> | ----- | -------- |
> | `read` | 只能调 `GET /api/v1/public/search`（查知识库原文片段，**不调 LLM、不花钱、不留会话**） |
> | `write` | 只读 + 发起对话（`POST /chat`、`/chat/stream`）—— **默认**，存量 key 全是这个 |
> | `admin` | 写入 + **管理本租户的知识库**（`GET/POST/DELETE /api/v1/public/documents`）—— 2026-10-26 补上真端点 |
>
> 包含关系：`write ⊇ read`，`admin ⊇ write`。
>
> ⚠️ **admin 那一档能删文档** —— 拿到这把 key 的系统可以清空本租户的知识库。
>
> **`key_sha256` 列（迁移 `034-add-api-key-sha256.ts`，2026-10-26 补）**：
> 以前鉴权只能按 8 位 `key_prefix` 粗筛，而 `idx_prefix` 是复合索引（`tenant_id, key_prefix`），
> **单独按 prefix 查走不了索引 → 每次鉴权全表扫**。
> 加一列 sha256(完整 key) + 唯一索引 → 索引点查定位到那一行，再用 bcrypt 验真。
> 存量 key（sha256 为 NULL）走慢路径，第一次鉴权成功时**自动回填**（自愈）。

### 提示词版本表（prompt_versions · 提示词管理）

> **C3 配套**。建表迁移：`src/migrations/010-create-prompt-versions-llm-config.ts`。

```sql
CREATE TABLE prompt_versions (
  id VARCHAR(36) PRIMARY KEY COMMENT 'UUID',
  tenant_id VARCHAR(36) NOT NULL COMMENT '所属租户',
  version VARCHAR(20) NOT NULL COMMENT '版本号（v1 / v2 …，租户内唯一）',
  status ENUM('draft', 'production', 'archived') DEFAULT 'draft' COMMENT '生产中 / 草稿 / 已归档',
  content MEDIUMTEXT NOT NULL COMMENT '提示词正文，支持 {{tenantName}} 占位符',
  description VARCHAR(200) COMMENT '这个版本改了什么（便于回溯）',
  deployed_at DATETIME(6) NULL COMMENT '发布到生产的时间',
  deployed_by VARCHAR(36) NULL COMMENT '发布人 user_id',
  created_by VARCHAR(36) NOT NULL COMMENT '创建人 user_id',
  created_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  UNIQUE KEY uk_prompt_versions_tenant_version (tenant_id, version),
  INDEX idx_prompt_versions_tenant_status (tenant_id, status)
) COMMENT '租户级提示词版本表';
```

> **`content` 是对原设计的改动**：原 DDL 只有 `file_path VARCHAR(500)` 指向仓库里的
> `.ts` 文件。指向文件的话后台只能「选版本」不能「编版本」，改提示词必须发版 ——
> 而 C3 要的是「租户在后台自定义」。所以正文入库，`file_path` 取消。
>
> **单租户同时只有一个 production**，由 `publishPromptVersion()` 在一个事务里保证
> （先全部转 archived，再置新的 production）。production / archived 不允许直接改。

### 租户模型表（tenant_models · 模型选择）

> **C4 配套**。建表迁移：`src/migrations/013-restructure-tenant-config.ts`。

```sql
CREATE TABLE tenant_models (
  id VARCHAR(36) PRIMARY KEY COMMENT 'UUID',
  tenant_id VARCHAR(36) NOT NULL COMMENT '所属租户',
  name VARCHAR(100) NOT NULL COMMENT '条目名（租户自定义，如「生产-快」）',
  provider VARCHAR(32) COMMENT '展示用标识，不参与调用',
  model_id VARCHAR(100) NOT NULL COMMENT '对话模型 id',
  base_url VARCHAR(500) NOT NULL COMMENT 'Anthropic 协议端点（已 normalize 成以 /v1 结尾）',
  api_key_enc BLOB NOT NULL COMMENT 'AES-256-GCM 密文；密钥来自 CONFIG_ENCRYPTION_KEY',
  api_key_hint VARCHAR(64) COMMENT '脱敏提示（4ff4…m3Bo），唯一允许回显的密钥形态',
  temperature DECIMAL(3,2) COMMENT 'NULL = 用进程级默认',
  max_output_tokens INT COMMENT 'NULL = 用进程级默认',
  prompt_cache_enabled BOOLEAN DEFAULT TRUE COMMENT '是否给系统提示词打 cacheControl',
  usage_scope ENUM('chat','memory') DEFAULT 'chat' COMMENT '用途：chat=对话模型 / memory=记忆抽取模型',
  is_active BOOLEAN DEFAULT FALSE COMMENT '是否是该 usage_scope 当前启用的模型',
  updated_by VARCHAR(36) COMMENT '最后修改人 user_id',
  created_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  INDEX idx_tenant_models_tenant (tenant_id)
) COMMENT '租户模型列表';
```

> **一个租户可以配多个模型**，逐条切换 —— 「自建网关 + 官方 API 并存」这类场景才表达得了。
> 每条都是**完整的连接配置**（端点 + 密钥 + 采样），不跟别的条目共享。
>
> **`usage_scope` 决定这条模型服务于哪条链路**（加列迁移 `018-add-tenant-model-usage-scope.ts`）：
>  - `chat`（默认）对话模型
>  - `memory` 记忆抽取模型 —— B4 的自动抽取是**独立的一次 LLM 调用**，
>    推理型模型的思考 token 全额算输出 token（一次实测 2000+），
>    租户单独配一条便宜模型给它用，是唯一能压这项成本的手段
>
> **每租户每个 `usage_scope` 恰有一条 `is_active`**，由 `activateTenantModel()` 在一个事务里保证
> （先全灭、再亮新的，**只在同 scope 内互斥**）；每个 scope 的第一条模型入库时自动成为
> 该 scope 的启用项，否则租户「配了却没选中」会一直走平台默认。
> 没配 `memory` 模型时，抽取**回落到对话模型**（行为跟没加这个字段之前一样）。
>
> **密钥铁律**：`api_key_enc` 存 AES-256-GCM 密文（密钥 = `CONFIG_ENCRYPTION_KEY`，
> sha256 派生 32 字节），**永不落明文**；`api_key_hint` 是唯一允许回显的形态。
> 密钥轮换期解不开会**降级到平台默认凭据 + 日志告警**，不会让整个对话失败。
>
> **base_url 的 SSRF 风险**：租户填的端点意味着我们的后端会向任意地址发请求。
> 生产默认拦截内网 / 回环 / 链路本地（含云元数据）/ CGNAT，且逐个 DNS 解析结果校验；
> dev 默认放开。要指自建局域网网关时设 `CONFIG_ALLOW_PRIVATE_LLM_ENDPOINT=true`。

### 租户通用配置表（tenant_settings · KV）

> **C4 / E2 配套**。建表迁移同上。

```sql
CREATE TABLE tenant_settings (
  id VARCHAR(36) PRIMARY KEY COMMENT 'UUID',
  tenant_id VARCHAR(36) NOT NULL COMMENT '所属租户',
  config_key VARCHAR(64) NOT NULL COMMENT '配置项键（对应 SETTINGS_REGISTRY）',
  config_value VARCHAR(1000) NOT NULL COMMENT '值（统一字符串，类型由 registry 决定）',
  updated_by VARCHAR(36) COMMENT '最后修改人 user_id',
  created_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  UNIQUE KEY uk_tenant_settings_key (tenant_id, config_key)
) COMMENT '租户通用配置（只存租户改过的值）';
```

> **存的是「租户改过的值」，不是「全部配置项」**：
> 键的**元信息**（类型 / 名称 / 分类 / 默认值 / 取值范围）在代码里
> —— `src/services/tenant-settings.ts` 的 `SETTINGS_REGISTRY`；本表只存 key + value。
>
> 这么切的理由：类型和范围校验必须有代码（手写解析），否则 KV 表会退化成人人可写的
> 万能垃圾桶；而后台页面按 registry 渲染，加一个配置项不用碰 SQL。
> 租户没配过的键**根本不占行**。
>
> **值的解析失败按「没配」处理**（回落默认 + 记 warn）—— 不能因为一个手滑存进去的
> 坏值就让整个对话挂掉。
>
> **三态语义**（`PUT /config/settings`）：`undefined` = 不改 / `null` = **清除覆盖回落到 .env** /
> 值 = 覆盖。`null` 那条特别容易写错成 no-op，后果是「用户一旦设过就再也改不回默认」。

### 评测结果明细表（evaluation_results · 每条 case 的分数）✅ D1 已落地 2026-10-24

> **D1 配套**。`evaluation_runs` 只存**平均分**；每条 case 的具体分数 + 裁判理由存在这张表。
>
> **表名跟初版设计稿不同**：设计稿写的是 `evaluation_run_items`，落地时用了
> `evaluation_results` —— 「result」跟 `evaluation_runs`（一次跑批）配对更清楚，
> 而且跟 `evaluation_items`（题目）区分得开：items 是**输入**，results 是**输出**。

```sql
CREATE TABLE evaluation_results (
  id VARCHAR(36) PRIMARY KEY COMMENT 'nanoid 21',
  run_id VARCHAR(36) NOT NULL COMMENT '所属评测运行',
  tenant_id VARCHAR(36) NOT NULL COMMENT '所属租户',
  item_id VARCHAR(36) COMMENT '对应 evaluation_items.id',
  question TEXT NOT NULL COMMENT '题目快照',
  answer TEXT NOT NULL COMMENT '模型这次的实际回答',
  reference_answer TEXT COMMENT '参考答案快照',
  scores JSON NOT NULL COMMENT '4 维分数 {accuracy, completeness, style, safety}（各 0~5）',
  judge_reason TEXT COMMENT '大模型裁判给的解释',
  input_tokens INT NOT NULL DEFAULT 0 COMMENT '生成 + 裁判消耗的输入 token',
  output_tokens INT NOT NULL DEFAULT 0 COMMENT '生成 + 裁判消耗的输出 token',
  cost DECIMAL(12,6) NOT NULL DEFAULT 0 COMMENT '本条花费（USD，估算值）',
  latency_ms INT COMMENT '本条总耗时（毫秒）',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) COMMENT '评分时间',
  INDEX idx_eval_results_run (run_id)
) COMMENT '评测每条 case 明细';
```

> **与初版设计稿的差异**：
> - 四个 `score_*` 字段合成一个 `scores` JSON：四个 0~5 的整数塞进 JSON 比四个 TINYINT 列更灵活
>   （以后加维度不用改表结构），代价是不能直接对某一维建索引 —— 但查询都是「按 run 取全部」，
>   没有按单维筛选的场景
> - 多了 `question` / `answer` / `reference_answer` 三个快照：
>   评测集改了 / 删了之后，历史跑批的明细仍然能读出来（跟 `evaluation_runs.dataset_name` 快照同理）
> - `duration_ms` 改名 `latency_ms`：跟 `traces.duration_ms` / `spans.duration_ms` 统一
> - `item_id` 从 `BIGINT` 改成 `VARCHAR(36)`：跟 `evaluation_items.id` 对齐

### 用户长期记忆表（user_memories）✅ B4 已落地 2026-10-24

```sql
CREATE TABLE user_memories (
  id VARCHAR(36) PRIMARY KEY COMMENT '记忆 id（nanoid 21）',
  tenant_id VARCHAR(36) NOT NULL COMMENT '所属租户',
  user_id VARCHAR(36) NOT NULL COMMENT '记忆所属用户（用户级记忆：同一租户下不同用户互不可见）',
  category ENUM('profile', 'preference', 'fact', 'context') NOT NULL DEFAULT 'fact' COMMENT '分类：画像 / 偏好 / 事实 / 情境',
  content VARCHAR(500) NOT NULL COMMENT '记忆正文（一句话陈述）',
  source ENUM('auto', 'user', 'admin') NOT NULL DEFAULT 'auto' COMMENT '来源：auto=模型自动抽取 / user=用户自己写 / admin=租户管理员写',
  confidence FLOAT NOT NULL DEFAULT 0.5 COMMENT '抽取置信度 0~1；用户自己写的为 1',
  status ENUM('active', 'archived') NOT NULL DEFAULT 'active' COMMENT '状态：active=生效中 / archived=已归档（软删，可恢复）',
  hit_count INT NOT NULL DEFAULT 0 COMMENT '被注入进提示词的次数',
  last_hit_at DATETIME(6) NULL COMMENT '最后一次被注入的时间',
  source_session_id VARCHAR(36) NULL COMMENT '抽取来源会话 id（回溯当时的原话用）',
  source_message_id VARCHAR(36) NULL COMMENT '抽取来源消息 id',
  embedding JSON NULL COMMENT '记忆正文的向量（归一化后的 float 数组）—— 用于按当前问题做相关性排序；NULL = 还没算',
  embedding_model VARCHAR(64) NULL COMMENT '生成 embedding 的模型名 —— 换 embedding 模型后据此判定旧向量作废',
  created_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) COMMENT '创建时间',
  updated_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) COMMENT '更新时间',
  INDEX idx_user_memories_tenant_user (tenant_id, user_id),
  INDEX idx_user_memories_tenant_created (tenant_id, created_at)
) COMMENT '用户长期记忆（B4 长期记忆）';
```

> **建表迁移**：`src/migrations/017-create-user-memories.ts`。
> **加 `embedding` / `embedding_model` 两列**：`src/migrations/035-user-memory-embedding.ts`
> （2026-10-26 · B4 的「记忆检索」那一项 —— 注入哪几条记忆按「跟当前问题相不相关」排）。
>
> ⚠️ **为什么向量存在这张表上，而不是另起一张表 / 放 Qdrant**：
> `user_memories` 有 `tenant_id` 列 → Sequelize 的租户作用域钩子自动补过滤，
> **向量存在这一行里就自动继承了租户隔离**（A1 的运行时强制）；
> 放向量库得重新手写一遍租户过滤 —— 那等于给自己开一个跨租户的口子。
> 量级也小（单用户最多 50 条自动记忆 + 手写的那几条），几百条向量在 DB 里算余弦是毫秒级。
>
> ⚠️ **代码先上线的降级**：迁移没跑时，启动会探一次这两列在不在，
> 不在就把它们**从模型里摘掉**（`Model.removeAttribute`），
> 之后所有对 `user_memories` 的查询退回老行为（记忆按固定顺序注入），不会挂。
>
> **为什么不用 `users.preferences` JSON 存**：那列能存零散偏好，但撑不住本功能要的
> 逐条列出 / 逐条改 / 逐条删 / 归档 / 记来源和置信度 / 注入时只取 top N。
> `users.preferences` 现在只存**记忆总开关**（`memory_enabled`），
> 记忆条目本体在这张表（见 `src/models/UserMemory.ts`）。
>
> **`source` 的语义是「最后一次为这条内容背书的角色」**：
> 用户手动改过一条 `auto` 记忆 → 变成 `user`；管理员改过 → 变成 `admin`。
> 自动抽取**只允许改 `source='auto'` 的行** —— 用户和管理员明确表达过的
> 比模型猜的权威，模型不许覆盖。
>
> **删除是软删**：自动抽取会改写旧记忆（update / archive），需要能恢复，
> 所以用 `status='archived'` 而不是物理删。管理员另有 `DELETE /memories/:id/permanent`
> 做合规清理（不可恢复）。
>
> **删用户会连带物理删掉他的记忆**（`DELETE /api/v1/admin/users/:id` 里一起做）——
> 留着就成了没人认领的孤儿行（后台「用户记忆」页按 `users` 表关联，
> 用户没了就再也看不到那些行，物理删除的合规清理入口也用不上了），
> 而里面可能还留着姓名 / 工号 / 地址。
>
> **不加外键**：跟 `evaluation_*` / `cost_logs` / `traces` 一致 ——
> 记忆要跨子系统查，外键只会拖慢写入。

---

### 多代理批次表（agent_runs · B6 多代理协作）✅ 已落地 2026-10-26

> **建表迁移**：`src/migrations/032-create-agent-runs.ts`
> **模型**：`src/models/AgentRun.ts` / `src/models/AgentStep.ts`

```sql
CREATE TABLE agent_runs (
  id VARCHAR(36) PRIMARY KEY COMMENT '批次 id（nanoid 21）',
  tenant_id VARCHAR(36) NOT NULL COMMENT '所属租户',
  session_id VARCHAR(36) COMMENT '触发的会话',
  user_id VARCHAR(36) COMMENT '触发者（匿名挂件 / 对外 API 为空）',
  turn_id VARCHAR(36) COMMENT '触发这轮对话的 assistant 消息 id —— 定位「本轮」的批次',
  question TEXT NOT NULL COMMENT '触发这次多代理的原始问题',
  state ENUM('running','completed','failed') DEFAULT 'running' COMMENT '批次状态',
  shared_state JSON COMMENT '共享状态：{ agent_key: 产出 }（子代理之间靠它协作）',
  result JSON COMMENT '最终结果',
  created_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) COMMENT '创建时间',
  updated_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6) COMMENT '更新时间',
  INDEX idx_agent_runs_session (session_id),
  INDEX idx_agent_runs_tenant_turn (tenant_id, turn_id)
) COMMENT '多代理批次（B6 多代理协作）';

CREATE TABLE agent_steps (
  id VARCHAR(36) PRIMARY KEY COMMENT '步骤 id（nanoid 21）',
  tenant_id VARCHAR(36) NOT NULL COMMENT '所属租户',
  run_id VARCHAR(36) NOT NULL COMMENT '所属批次',
  agent VARCHAR(64) NOT NULL COMMENT '子代理角色 key',
  task TEXT NOT NULL COMMENT '子任务描述',
  output JSON COMMENT '子代理产出',
  state ENUM('ok','failed') DEFAULT 'ok' COMMENT '这一步的结果',
  error VARCHAR(1000) COMMENT '失败原因',
  span_id VARCHAR(36) COMMENT '关联的 trace span（调用树靠它）',
  created_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) COMMENT '调用时间',
  INDEX idx_agent_steps_run (run_id, created_at),
  INDEX idx_agent_steps_tenant (tenant_id)
) COMMENT '多代理的每一步（B6 · 调用树）';
```

> ⚠️ **为什么是独立两张表，不塞进 `sessions.metadata`**：
> ① metadata 每轮对话都要读，多代理的产出（几个 KB）会拖慢每一轮；
> ② metadata 是 JSON 列没有独立索引，「查这个会话跑过哪些批次」只能全表扫；
> ③ 共享状态会**越滚越大**（每个子代理的产出都进去）。

> ⚠️ **`turn_id` 是「本轮」的锚点**：一轮对话里主 agent 派的每一次活
> 属于**同一个批次**（共享状态互通），下一轮就是新批次。

---

## 5.2 关键索引策略

- **`tenant_id` + 时间**：所有表都有，因为多租户按时间翻页是最常见的查询模式
- **状态字段**：`missions.state`、`evaluation_runs.status`、`documents.status` 上加索引，后台要按状态筛选
- **JSON 字段**：MySQL 8.0 支持 JSON 字段上建函数索引（按需启用）。比如 `documents((CAST(metadata->'$.doc_id' AS CHAR(36))))`，比 `JSON_EXTRACT` 直接放在 WHERE 里快

## 5.3 数据量估算（按 1000 DAU）

| 表                                     | 日增量   | 年增量   | 总占用（含索引） |
| -------------------------------------- | -------- | -------- | ---------------- |
| system_users                           | 0        | 1~5      | < 1 KB           |
| tenants                                | 0        | ~10      | < 1 MB           |
| users                                  | ~5       | ~2000    | ~500 KB          |
| sessions                               | ~3000    | ~110 万  | ~150 MB          |
| messages                               | ~30000   | ~1100 万 | ~3 GB            |
| documents                              | ~50      | ~2 万    | ~200 MB          |
| evaluation_datasets / evaluation_items | ~1 条/月 | ~2000    | ~50 MB           |
| evaluation_runs                        | 4        | ~1500    | ~1 MB            |
| evaluation_results                    | ~800     | ~30 万   | ~80 MB           |
| traces                                 | ~3000    | ~110 万  | ~800 MB          |
| spans                                  | ~30000   | ~1100 万 | ~5 GB            |
| api_keys                               | < 1      | ~10      | < 1 MB           |
| prompt_versions                        | < 1      | ~20      | < 1 MB           |
| tenant_models                          | < 1      | ~5       | < 10 KB          |
| tenant_settings                        | < 1      | ~10      | < 10 KB          |
| audit_logs                             | ~300     | ~10 万   | ~50 MB           |

向量数据存 Qdrant，不占 MySQL 空间。**messages** 和 **spans** 是增长主力，要按月份分区（PARTITION BY RANGE）以控制单表大表查询性能。

## 5.4 备份策略

- MySQL 手动全量备份：`mysqldump`（命令见 [11-部署运维与成本.md §11.4](./11-部署运维与成本.md)）
- 大规模生产换 Percona XtraBackup 做物理备份
- **不做的事**（本项目不部署到云，见 [11 §11.6](./11-部署运维与成本.md)）：
  - ❌ 备份文件上传到对象存储
  - ❌ 保留 30 天 + 月初归档到冷存储
  - ❌ 关键表异地备份

> ⚠️ 这一段以前写的是「上传对象存储 / 保留 30 天 / 冷存储 / 异地备份」——
> 那是**云部署时期**的残留，跟 [11 §11.6](./11-部署运维与成本.md) 明确写的
> 「❌ 异地备份 / 冷存储归档」**直接矛盾**。以 11 为准（本项目不上云）。

## 5.5 迁移与版本管理

- 用 `sequelize-cli` + `umzug` 管理 schema 变更；每个迁移写 `up(sql)` + `down(sql)` 函数
- 模型定义在 `src/models/`（`sequelize-typescript` 装饰器风格），迁移文件在 `src/migrations/`
- 重大变更（删字段、改字段类型）走 PR 评审 + staging 验证 + 灰度
- **schema 变更历史在哪**：`src/migrations/` 里的迁移文件本身就是变更日志
  （每个文件一个可回滚的变更）；「哪些已经应用了」看 `sequelize_meta` 表。
  ⚠️ 以前这里写的是「每个发版记录 schema 变更日志，写在 `docs/changelog/db.md`」——
  **那个文件从来不存在**（docs/ 下没有 changelog/ 目录）
