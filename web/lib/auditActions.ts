/**
 * 审计动作的中文标签 —— 租户后台（/admin/audit）和平台方（/system/audit）**共用一份**
 *
 * 2026-10-26 抽出来的：原来两个页面各抄了一份 `ACTION_LABEL`，结果互相漂移 ——
 * 租户后台那份缺 `PASSWORD_CHANGED` / `API_KEY_SCOPE_CHANGED`，
 * 平台方那份缺 `USER_MEMORY_PURGED` 之外的几条，两边都缺后来加的租户级 action。
 * 现在只有这一份，加 action 时改一处。
 *
 * ⚠️ **这份要跟后端 `src/models/AuditLog.ts` 的 `AuditAction` 联合类型对齐**。
 *    认不出来的 action 原样显示（`actionLabel()` 兜底）——
 *    后端加新类型时不用改前端就能看，但补一条中文标签更好读。
 */
export const ACTION_LABEL: Record<string, string> = {
  // —— 平台方（system 子系统）——
  TENANT_CREATED: '创建租户',
  TENANT_UPDATED: '修改租户资料',
  TENANT_ADMIN_PASSWORD_RESET: '重置租户 admin 密码',
  TENANT_STATUS_CHANGE: '修改租户启停',
  TENANT_EXPIRES_CHANGE: '修改租户到期时间',

  // —— 租户后台：用户 ——
  USER_CREATED: '创建用户',
  USER_UPDATED: '修改用户',
  USER_DELETED: '删除用户',

  // —— 租户后台：知识库 ——
  DOCUMENT_UPLOAD: '上传文档',
  DOCUMENT_DELETE: '删除文档',
  DOCUMENT_INDEX_FAILED: '文档索引失败',

  // —— 租户后台：模型 / 提示词 / 设置 ——
  TENANT_MODEL_CREATE: '新建模型配置',
  TENANT_MODEL_UPDATE: '修改模型配置',
  TENANT_MODEL_ACTIVATE: '启用模型',
  TENANT_MODEL_DELETE: '删除模型',
  PROMPT_VERSION_CREATE: '新建提示词版本',
  PROMPT_VERSION_DELETE: '删除提示词版本',
  PROMPT_PUBLISH: '发布提示词',
  PROMPT_ROLLBACK: '回滚提示词',
  TENANT_SETTINGS_CHANGE: '修改租户设置',

  // —— 租户后台：对外 API 密钥 ——
  API_KEY_CREATED: '创建 API Key',
  API_KEY_REVOKED: '吊销 API Key',
  API_KEY_SCOPE_CHANGED: '修改 API Key 权限',

  // —— 租户后台：工具 ——
  TOOL_CREATED: '注册工具',
  TOOL_UPDATED: '修改工具',
  TOOL_ENABLED: '启用工具',
  TOOL_DISABLED: '禁用工具',
  TOOL_DELETED: '删除工具',

  // —— 租户后台：评测 ——
  EVALUATION_DATASET_CREATED: '创建评测集',
  EVALUATION_DATASET_DELETED: '删除评测集',
  EVALUATION_RUN_STARTED: '触发评测跑批',
  EVALUATION_SCORE_DROPPED: '评测分数下跌',

  // —— 租户后台：长期记忆 ——
  USER_MEMORY_CREATED: '新建记忆',
  USER_MEMORY_UPDATED: '修改记忆',
  USER_MEMORY_ARCHIVED: '归档记忆',
  USER_MEMORY_RESTORED: '恢复记忆',
  /** 历史值（早期只有管理员端物理删时用过），保留兼容 */
  USER_MEMORY_DELETED: '删除记忆',
  /** 物理删除（不可恢复） */
  USER_MEMORY_PURGED: '物理删除记忆',
  USER_MEMORY_CLEARED: '清空记忆',
  USER_MEMORY_TOGGLED: '开关自动记忆',
  USER_MEMORY_EXTRACTED: '抽取记忆',

  // —— 账号安全 ——
  PASSWORD_CHANGED: '修改密码',

  // —— 平台级信号（限流 / 安全 / 成本）——
  RATE_LIMIT_EXCEEDED: '触发限流',
  PROMPT_INJECTION_BLOCKED: '提示词注入拦截',
  CONTENT_MODERATION_BLOCKED: '内容审核拦截',
  COST_BUDGET_EXCEEDED: '成本超预算',
};

/** 拦截类操作标红 —— 运维最关心的就是这几类 */
export const ALERT_ACTIONS = new Set([
  'PROMPT_INJECTION_BLOCKED',
  'CONTENT_MODERATION_BLOCKED',
  'RATE_LIMIT_EXCEEDED',
  'COST_BUDGET_EXCEEDED',
  'DOCUMENT_INDEX_FAILED',
]);

/** 取中文标签；认不出来的 action 原样返回（后端加新类型时不用改前端就能看） */
export function actionLabel(action: string): string {
  return ACTION_LABEL[action] ?? action;
}
