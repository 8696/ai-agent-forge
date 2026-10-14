# 06 · API 接口清单

> 列主要接口，每个标 方法 / 路径 / 用途 / 鉴权。
>
> **核心架构原则**：3 套子系统完全独立——`/api/v1/system/*` / `/api/v1/admin/*` / `/api/v1/customer/*` 各管各的 auth（login / me / change-password）。详见 [03-b-技术栈-后端栈.md §B.5](./03-b-技术栈-后端栈.md)。

## 6.1 鉴权 API

### 6.1.1 system 子系统（SaaS 平台方）

| 方法  | 路径                                              | 用途                                                                                                     | 鉴权                             |
| ----- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------- |
| POST  | `/api/v1/system/login`                            | SaaS 平台方登录（**不要 `tenant_code`**，跨租户）                                                        | —                                |
| GET   | `/api/v1/system/me`                               | 取当前 system user 信息                                                                                  | requireSystemUser（role=system） |
| POST  | `/api/v1/system/change-password`                  | system user 改自己密码                                                                                   | requireSystemUser                |
| POST  | `/api/v1/system/tenants`                          | 建租户 + 初始化 admin                                                                                    | requireSystemUser                |
| GET   | `/api/v1/system/tenants`                          | 列所有租户（含 admin email，**含 `status` / `expires_at`**）                                             | requireSystemUser                |
| GET   | `/api/v1/system/tenants/:id`                      | 单个租户详情                                                                                             | requireSystemUser                |
| PATCH | `/api/v1/system/tenants/:id`                      | 改 name / plan                                                                                           | requireSystemUser                |
| PATCH | `/api/v1/system/tenants/:id/expires_at`           | **F2**：改租户到期时间（body: `{expires_at: ISO8601 \| null}`，null = 永不过期）                         | requireSystemUser                |
| PATCH | `/api/v1/system/tenants/:id/status`               | **F2**：启用 / 禁用租户（body: `{status: 'active'\|'disabled'}`；禁用 `code='system'` 的初始租户 → 400） | requireSystemUser                |
| POST  | `/api/v1/system/tenants/:id/admin/reset-password` | 重置租户 admin 密码                                                                                      | requireSystemUser                |

**登录请求体**（`POST /api/v1/system/login`）：

```json
{ "email": "platform-admin@local.test", "password": "xxx" }
```

### 6.1.2 admin 子系统（租户后台）

| 方法 | 路径                            | 用途                                 | 鉴权                       |
| ---- | ------------------------------- | ------------------------------------ | -------------------------- |
| POST | `/api/v1/admin/login`           | admin 登录（**必填 `tenant_code`**） | —                          |
| GET  | `/api/v1/admin/me`              | 取当前 admin 信息                    | requireAdmin（role=admin） |
| POST | `/api/v1/admin/change-password` | admin 改自己密码                     | requireAdmin               |

**登录请求体**（`POST /api/v1/admin/login`）：

```json
{ "email": "admin@acme-corp.test", "password": "xxx", "tenant_code": "acme-corp" }
```

### 6.1.3 customer 子系统（租户前台）

| 方法 | 路径                               | 用途                                    | 鉴权                             |
| ---- | ---------------------------------- | --------------------------------------- | -------------------------------- |
| POST | `/api/v1/customer/login`           | customer 登录（**必填 `tenant_code`**） | —                                |
| GET  | `/api/v1/customer/me`              | 取当前 customer 信息                    | requireCustomer（role=customer） |
| POST | `/api/v1/customer/change-password` | customer 改自己密码                     | requireCustomer                  |

**登录请求体**（`POST /api/v1/customer/login`）：

```json
{ "email": "alice@acme-corp.test", "password": "xxx", "tenant_code": "acme-corp" }
```

### 6.1.4 通用规则

- **统一 401 响应**：`{"code":"AUTH_ERROR","message":"邮箱或密码错误"}`——不泄露「用户不存在」「租户不存在」「租户已禁用」「租户已到期」或「角色不对」F2 起，禁用 / 到期的租户在 `admin/login` + `customer/login` 返回**完全同响应体**（message 也用「邮箱或密码错误」），防账号枚举
- **5 次失败 → 锁定 15 分钟**（`src/lib/login-lock.ts`）
- **每个子系统的 login 端点强制只查自己桶的角色**：
  - `admin/login` 只能查 `role='admin'`（admin 账号）
  - `customer/login` 只能查 `role='customer'`（customer 账号）
  - `system/login` 查 `system_users` 表（无 role 概念）
- **租户闸门（F2）**：admin/customer login 查到 `Tenant` 后立刻校验 `status='active'` 且 `expires_at` 未到（NULL 视为永不过），任一不满足 → 401（与密码错同响应体）；校验失败时不查 `User`（减少泄漏面）
- **跨子系统 token**：admin token 调 `customer/me` → 401；customer token 调 `admin/login` → 401
- **JWT payload**：`{sub, role: 'system'}`（无 tenant_id）/ `{sub, tenant_id, role: 'admin'|'customer'}`

> **历史**：早期版本用 `/api/v1/auth/login` + `login_type` 一个端点多种身份，已被 3 套独立端点取代——每套子系统的 SQL 都直接 `where: { role: '...' }` 锁死。

## 6.2 对外 API（嵌入用，Step 5+ 实现）

| 方法 | 路径                            | 用途                          | 鉴权    |
| ---- | ------------------------------- | ----------------------------- | ------- |
| POST | `/api/v1/chat`                  | 发消息给 Agent                | API Key |
| POST | `/api/v1/chat/stream`           | 流式响应（SSE）               | API Key |
| GET  | `/api/v1/sessions/:id`          | 获取会话历史                  | API Key |
| POST | `/api/v1/sessions/:id/feedback` | 用户对回复打分（点赞 / 点踩） | API Key |

> 这些是「客户的客户」调用的 API，挂在 `api_keys`（租户生成）下，不走 JWT。

## 6.3 后台管理 API（admin 子系统，Step 13 落）

| 方法 | 路径                             | 用途                                 | 鉴权         |
| ---- | -------------------------------- | ------------------------------------ | ------------ |
| GET  | `/api/v1/admin/dashboard`        | 首页关键指标                         | requireAdmin |
| GET  | `/api/v1/admin/traces`           | Trace 列表                           | requireAdmin |
| GET  | `/api/v1/admin/traces/:id`       | Trace 详情                           | requireAdmin |
| GET  | `/api/v1/admin/cost/breakdown`   | 成本拆解                             | requireAdmin |
| GET  | `/api/v1/admin/eval/datasets`    | 评测集列表                           | requireAdmin |
| POST | `/api/v1/admin/eval/datasets`    | 上传评测集（JSONL）                  | requireAdmin |
| POST | `/api/v1/admin/eval/runs`        | 触发评测                             | requireAdmin |
| GET  | `/api/v1/admin/eval/runs/:id`    | 评测结果                             | requireAdmin |
| GET  | `/api/v1/admin/knowledge`        | 文档列表                             | requireAdmin |
| POST | `/api/v1/admin/knowledge/upload` | 上传文档（PDF / Word / MD / TXT）    | requireAdmin |
| GET  | `/api/v1/admin/tools`            | 工具列表                             | requireAdmin |
| GET  | `/api/v1/admin/users`            | 用户列表（CRUD，**已 Step 2 实现**） | requireAdmin |

## 6.4 健康检查（公共）

| 方法 | 路径          | 用途                             |
| ---- | ------------- | -------------------------------- |
| GET  | `/api/health` | 服务存活（已 Step 1 实现）       |
| GET  | `/api/ready`  | 服务就绪（数据库 / Qdrant 都通） |

## 6.5 Dev-only（生产 404）

| 方法 | 路径                  | 用途                                                                      |
| ---- | --------------------- | ------------------------------------------------------------------------- |
| POST | `/api/_dev/probe/llm` | 调任意 provider 的 LLM 探活（minimax / zhipu / deepseek / qwen / custom） |

> NODE_ENV=production 时此路由直接 404，不暴露。进生产前可以整个 `_dev/` 删掉。
