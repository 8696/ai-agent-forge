# 06 · API 接口清单

> 列主要接口，每个标 方法 / 路径 / 用途 / 鉴权。

## 6.1 鉴权 API

> **所有非 SaaS 平台方的登录都要带 `tenant_code`**，因为邮箱不跨租户唯一。

| 方法 | 路径 | 用途 | 鉴权 |
|------|------|------|------|
| POST | `/api/v1/system/login` | SaaS 平台方登录（不要租户号） | 系统账号 |
| POST | `/api/v1/system/tenants` | SaaS 平台方创建租户 + 初始化管理员 | 系统 JWT |
| POST | `/api/v1/auth/login` | 后台 / 前台登录（必填 `tenant_code` + `login_type`） | — |
| POST | `/api/v1/auth/change-password` | 首次登录强制改密码 | JWT |
| GET | `/api/v1/auth/me` | 取当前用户信息 | JWT |

**登录请求体**（`POST /api/v1/auth/login`）：

```json
{
  "email": "admin@acme.com",
  "password": "xxx",
  "tenant_code": "acme-corp",
  "login_type": "admin" | "customer"
}
```

后端验证：`WHERE email = ? AND tenant_id = (SELECT id FROM tenants WHERE code = ?)` + `role` 与 `login_type` 一致才放行。

错误响应：`401 邮箱或密码错误`（不泄露「用户是否存在」「租户是否存在」）。

## 6.2 对外 API（嵌入用）

| 方法 | 路径 | 用途 | 鉴权 |
|------|------|------|------|
| POST | `/api/v1/chat` | 发消息给 Agent | API Key |
| POST | `/api/v1/chat/stream` | 流式响应（SSE） | API Key |
| GET | `/api/v1/sessions/:id` | 获取会话历史 | API Key |
| POST | `/api/v1/sessions/:id/feedback` | 用户对回复打分（点赞 / 点踩） | API Key |

## 6.3 后台管理 API

| 方法 | 路径 | 用途 | 鉴权 |
|------|------|------|------|
| GET | `/api/admin/dashboard` | 首页关键指标 | JWT |
| GET | `/api/admin/traces` | Trace 列表（按时间 / 用户筛选） | JWT |
| GET | `/api/admin/traces/:id` | Trace 详情 | JWT |
| GET | `/api/admin/cost/breakdown` | 成本拆解（按用户 / 场景 / 模型） | JWT |
| GET | `/api/admin/eval/datasets` | 评测集列表 | JWT |
| POST | `/api/admin/eval/datasets` | 上传评测集 | JWT |
| POST | `/api/admin/eval/runs` | 触发评测 | JWT |
| GET | `/api/admin/eval/runs/:id` | 评测结果 | JWT |
| GET | `/api/admin/knowledge` | 文档列表 | JWT |
| POST | `/api/admin/knowledge/upload` | 上传文档 | JWT |
| GET | `/api/admin/tools` | 工具列表 | JWT |
| GET | `/api/admin/users` | 用户列表（含创建 / 改 / 删 / 重置密码） | JWT |

## 6.4 健康检查

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/health` | 服务存活 |
| GET | `/ready` | 服务就绪（数据库 / Qdrant 都通） |