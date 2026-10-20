# 05-a · 数据模型 · MySQL

> **本文件是 `05-数据模型.md` 的 §5.1-§5.5 节**（原主文件已拆分为 05-a / 05-b 两份）。本份负责**MySQL 12 张核心表的 DDL + 索引策略 + 数据量估算 + 备份 + 迁移管理**。
> 向量库 Qdrant 部分见 `05-b-数据模型-qdrant.md`。

MySQL 8.0，字符集 `utf8mb4_unicode_ci`。所有时间字段用 `DATETIME(6)`（微秒精度，便于 trace 分析），主键统一 `VARCHAR(36)`（UUID）。

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
  channel ENUM('widget', 'email', 'api') NOT NULL COMMENT '接入渠道',
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

### 知识库文档表（documents）

```sql
CREATE TABLE documents (
  id VARCHAR(36) PRIMARY KEY COMMENT 'UUID',
  tenant_id VARCHAR(36) NOT NULL COMMENT '所属租户',
  title VARCHAR(500) NOT NULL COMMENT '文档标题（原始文件名）',
  source VARCHAR(500) COMMENT '本地存储路径（./data/uploads/{tenant_id}/xxx.pdf）',
  file_type ENUM('pdf', 'word', 'markdown', 'txt') COMMENT '文件类型',
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
> **`file_type` 的 `'word'` 目前是预留值**：上传只放行 `pdf` / `markdown` / `txt`
> （解析器没有引入 mammoth）。传 `.docx` 会被 400 挡掉，库里的 `file_type` 也就不会出现 `word`。

### 工具注册表（tools）

```sql
CREATE TABLE tools (
  id VARCHAR(36) PRIMARY KEY COMMENT 'UUID',
  name VARCHAR(100) NOT NULL COMMENT '工具名（英文，调用时用）',
  description TEXT COMMENT '工具描述（给 LLM 看，决定是否调用）',
  type ENUM('builtin', 'mcp') DEFAULT 'builtin' COMMENT 'builtin=项目自带；mcp=外部 MCP 服务',
  config JSON COMMENT '配置：mcp_server_url / mcp_server_path / headers 等',
  enabled BOOLEAN DEFAULT TRUE COMMENT '是否启用',
  created_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) COMMENT '创建时间',
  INDEX idx_tenant_name (tenant_id, name)
) COMMENT '工具注册表（Phase 2 启用）';
```

### 任务表（missions，工作流主表）

```sql
CREATE TABLE missions (
  id VARCHAR(36) PRIMARY KEY COMMENT 'UUID',
  tenant_id VARCHAR(36) NOT NULL COMMENT '所属租户',
  session_id VARCHAR(36) COMMENT '触发的会话（NULL 表示非对话触发的后台任务）',
  type VARCHAR(100) NOT NULL COMMENT '任务类型（如 modify_order / issue_ticket）',
  state ENUM('pending', 'running', 'awaiting_confirmation', 'completed', 'failed', 'cancelled') DEFAULT 'pending' COMMENT '任务状态机',
  is_sensitive BOOLEAN DEFAULT FALSE COMMENT '是否敏感操作（true 需 HITL 确认）',
  context JSON COMMENT '任务输入上下文（订单 ID、改地址等）',
  result JSON COMMENT '任务执行结果',
  created_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) COMMENT '创建时间',
  updated_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6) COMMENT '更新时间',
  INDEX idx_session (session_id),
  INDEX idx_state (state, updated_at)
) COMMENT '任务表（Phase 2 启用）';
```

### 评测集表（evaluation_datasets / evaluation_items）

```sql
CREATE TABLE evaluation_datasets (
  id VARCHAR(36) PRIMARY KEY COMMENT 'UUID',
  tenant_id VARCHAR(36) NOT NULL COMMENT '所属租户',
  name VARCHAR(200) NOT NULL COMMENT '评测集名（如 "客服 V1"）',
  version INT DEFAULT 1 COMMENT '版本（同名多次上传递增）',
  item_count INT DEFAULT 0 COMMENT '条目数',
  source VARCHAR(500) COMMENT '原始 JSONL 文件名',
  created_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) COMMENT '上传时间',
  UNIQUE KEY uk_tenant_name_version (tenant_id, name, version)
) COMMENT '评测集主表';

CREATE TABLE evaluation_items (
  id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '自增 ID',
  dataset_id VARCHAR(36) NOT NULL COMMENT '所属评测集',
  question TEXT NOT NULL COMMENT '测试问题',
  reference_answer MEDIUMTEXT COMMENT '参考答案（人工写的）',
  scenario VARCHAR(100) COMMENT '场景分类（退款 / 改地址 / 闲聊）',
  difficulty ENUM('easy', 'medium', 'hard') DEFAULT 'medium' COMMENT '难度',
  metadata JSON COMMENT '附加元数据',
  INDEX idx_dataset (dataset_id)
) COMMENT '评测集条目';
```

### 评测运行表（evaluation_runs）

```sql
CREATE TABLE evaluation_runs (
  id VARCHAR(36) PRIMARY KEY COMMENT 'UUID',
  tenant_id VARCHAR(36) NOT NULL COMMENT '所属租户',
  dataset_id VARCHAR(36) NOT NULL COMMENT '使用的评测集',
  prompt_version VARCHAR(50) COMMENT '跑评测时的提示词版本（追变更用的）',
  model VARCHAR(100) COMMENT '跑评测用的模型',
  status ENUM('queued', 'running', 'completed', 'failed') DEFAULT 'queued' COMMENT '运行状态',
  total_count INT DEFAULT 0 COMMENT '总条目数',
  completed_count INT DEFAULT 0 COMMENT '已完成数',
  avg_accuracy DECIMAL(3,2) COMMENT '准确性平均分（1-5）',
  avg_completeness DECIMAL(3,2) COMMENT '完整性平均分',
  avg_style DECIMAL(3,2) COMMENT '风格平均分',
  avg_safety DECIMAL(3,2) COMMENT '安全平均分',
  total_cost DECIMAL(10,4) COMMENT '本次评测总花费',
  started_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) COMMENT '开始时间',
  finished_at DATETIME(6) COMMENT '结束时间',
  INDEX idx_dataset (dataset_id, started_at)
) COMMENT '评测运行（每次跑一次一条）';
```

### 调用链路表（traces / spans）

```sql
CREATE TABLE traces (
  trace_id VARCHAR(36) PRIMARY KEY COMMENT 'UUID；一次请求一个 trace',
  tenant_id VARCHAR(36) NOT NULL COMMENT '所属租户',
  session_id VARCHAR(36) COMMENT '所属会话',
  user_id VARCHAR(36) COMMENT '触发用户',
  root_span_name VARCHAR(200) COMMENT '根 span 名（如 "agent_loop"）',
  start_time DATETIME(6) COMMENT '开始时间',
  end_time DATETIME(6) COMMENT '结束时间',
  duration_ms INT COMMENT '总耗时（毫秒）',
  status ENUM('ok', 'error') DEFAULT 'ok' COMMENT '整体状态',
  total_input_tokens INT COMMENT '汇总输入 token',
  total_output_tokens INT COMMENT '汇总输出 token',
  total_cost DECIMAL(10,6) COMMENT '总花费',
  INDEX idx_tenant_start (tenant_id, start_time),
  INDEX idx_session (session_id)
) COMMENT '调用链路（trace）';

CREATE TABLE spans (
  span_id VARCHAR(36) PRIMARY KEY COMMENT 'UUID；每步一个 span',
  trace_id VARCHAR(36) NOT NULL COMMENT '所属 trace',
  parent_span_id VARCHAR(36) COMMENT '父 span（NULL 表示根 span）',
  name VARCHAR(200) NOT NULL COMMENT 'span 名（如 "rag_search" / "llm_call"）',
  start_time DATETIME(6) COMMENT '开始时间',
  end_time DATETIME(6) COMMENT '结束时间',
  duration_ms INT COMMENT '本步耗时（毫秒）',
  attributes JSON COMMENT 'span 属性（tokens / cost / 工具调用详情）',
  events JSON COMMENT 'span 生命周期事件',
  status ENUM('ok', 'error') DEFAULT 'ok' COMMENT '本步状态',
  INDEX idx_trace (trace_id, start_time),
  INDEX idx_parent (parent_span_id)
) COMMENT '调用链路步骤（span）';
```

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

> **E1 配套**。租户 admin 在后台「API 密钥」页生成 API Key，外部系统拿这个 Key 调 `/api/v1/chat` 等端点。

```sql
CREATE TABLE api_keys (
  id VARCHAR(36) PRIMARY KEY COMMENT 'UUID',
  tenant_id VARCHAR(36) NOT NULL COMMENT '所属租户',
  name VARCHAR(100) NOT NULL COMMENT '租户自己起的名字（"生产环境 / 测试环境"）',
  key_prefix VARCHAR(10) NOT NULL COMMENT 'key 前 8 位（用于 UI 显示识别，不存完整 key）',
  key_hash VARCHAR(255) NOT NULL COMMENT '完整 key 的 bcrypt hash',
  last_used_at DATETIME(6) NULL COMMENT '最后使用时间',
  expires_at DATETIME(6) NULL COMMENT '过期时间；NULL = 不过期',
  revoked_at DATETIME(6) NULL COMMENT '撤销时间（软删除）',
  created_by VARCHAR(36) NOT NULL COMMENT '哪个 admin 创建的',
  created_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) COMMENT '创建时间',
  INDEX idx_tenant (tenant_id, created_at),
  INDEX idx_prefix (tenant_id, key_prefix)
) COMMENT '租户 API 密钥';
```

> 完整 key **只在创建时返回一次**（UI 上「复制」按钮），DB 只存 hash。丢了只能重新生成。

### 提示词版本表（prompt_versions · 提示词管理）

> **C3 配套**。提示词文件用 git 管，DB 存「哪个版本在生产、哪些是草稿」元信息。

```sql
CREATE TABLE prompt_versions (
  id VARCHAR(36) PRIMARY KEY COMMENT 'UUID',
  tenant_id VARCHAR(36) NOT NULL COMMENT '所属租户',
  version VARCHAR(20) NOT NULL COMMENT '版本号（''v1'' / ''v2''，与文件名对应）',
  status ENUM('draft', 'production', 'archived') DEFAULT 'draft' COMMENT '生产中 / 草稿 / 已归档',
  file_path VARCHAR(500) NOT NULL COMMENT '对应 `shared/prompts/customer-service/system.v1.ts`',
  deployed_at DATETIME(6) NULL COMMENT '部署到生产的时间',
  deployed_by VARCHAR(36) NULL COMMENT '哪个 admin 部署的',
  created_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) COMMENT '创建时间',
  UNIQUE KEY uk_tenant_version (tenant_id, version),
  INDEX idx_tenant_status (tenant_id, status)
) COMMENT '提示词版本元信息';
```

### 评测结果明细表（evaluation_run_items · 每条 case 的分数）

> **D1 配套**。`evaluation_runs` 只存**平均分**；每条 case 的具体分数 + 裁判理由存在这张表。

```sql
CREATE TABLE evaluation_run_items (
  id BIGINT PRIMARY KEY AUTO_INCREMENT COMMENT '自增 ID',
  run_id VARCHAR(36) NOT NULL COMMENT '所属评测运行',
  item_id BIGINT NOT NULL COMMENT '关联 evaluation_items.id',
  actual_answer MEDIUMTEXT COMMENT '模型这次的实际回答',
  score_accuracy TINYINT COMMENT '准确性 1-5 分',
  score_completeness TINYINT COMMENT '完整性 1-5 分',
  score_style TINYINT COMMENT '风格 1-5 分',
  score_safety TINYINT COMMENT '安全 1-5 分',
  total_score TINYINT COMMENT '4 维平均（1-5）',
  judge_reasoning TEXT COMMENT '大模型裁判给的解释',
  input_tokens INT COMMENT '本条 input tokens',
  output_tokens INT COMMENT '本条 output tokens',
  cost DECIMAL(10,6) COMMENT '本条花费',
  duration_ms INT COMMENT '本条耗时',
  created_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) COMMENT '评分时间',
  INDEX idx_run (run_id),
  INDEX idx_item (item_id)
) COMMENT '评测每条 case 明细';
```

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
| evaluation_run_items                   | ~800     | ~30 万   | ~80 MB           |
| traces                                 | ~3000    | ~110 万  | ~800 MB          |
| spans                                  | ~30000   | ~1100 万 | ~5 GB            |
| api_keys                               | < 1      | ~10      | < 1 MB           |
| prompt_versions                        | < 1      | ~20      | < 1 MB           |
| audit_logs                             | ~300     | ~10 万   | ~50 MB           |

向量数据存 Qdrant，不占 MySQL 空间。**messages** 和 **spans** 是增长主力，要按月份分区（PARTITION BY RANGE）以控制单表大表查询性能。

## 5.4 备份策略

- MySQL 每日全量备份：`mysqldump`（开发与小规模生产）；大规模生产换 Percona XtraBackup 做物理备份
- 备份文件上传到对象存储
- 保留 30 天，月初归档到冷存储
- 关键表（`tenants`、`users`、`documents`）单独做异地备份

## 5.5 迁移与版本管理

- 用 `sequelize-cli` + `umzug` 管理 schema 变更；每个迁移写 `up(sql)` + `down(sql)` 函数
- 模型定义在 `src/models/`（`sequelize-typescript` 装饰器风格），迁移文件在 `src/migrations/`
- 重大变更（删字段、改字段类型）走 PR 评审 + staging 验证 + 灰度
- 文档归档：每个发版记录 schema 变更日志，写在 `docs/changelog/db.md`
