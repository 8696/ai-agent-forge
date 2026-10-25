/**
 * 租户号的校验规则 —— **前后端共用一份**（别各写各的）
 *
 * ## 为什么要共享
 *
 * 2026-10-25 审计发现前端有**三份**手抄的正则，而且**互相不一致**：
 *
 * | 位置                              | 原来的写法            | 问题                     |
 * | --------------------------------- | --------------------- | ------------------------ |
 * | `web/pages/admin/AdminLoginPage`  | `/^[a-z0-9-]{3,32}$/` | ✅                       |
 * | `web/pages/customer/CustomerLoginPage` | `/^[a-z0-9-]{3,32}$/` | ✅                    |
 * | `web/pages/system/TenantsPage`    | `/^[a-z0-9-]+$/`      | ❌ **漏了长度** —— 1 个字符的租户号前端放行、后端 400 |
 *
 * 后端走 `src/lib/validators.ts` 的 `tenantCodeSchema`（min 3 / max 32 / 正则）。
 * 两边各写各的 → 前端校验通过、后端拒绝，用户看到的是「表单过了但接口报错」。
 *
 * ## 规则本身（docs/12-a §A2）
 *
 * 全小写字母 + 数字 + 连字符，3~32 位。
 *
 * ⚠️ `shared/` 目录**必须零依赖**（前后端都能直接 import）——
 *    所以这里只放常量，不 import zod。后端的 zod schema 用这些常量拼出来。
 */

/** 最少几位 */
export const TENANT_CODE_MIN_LENGTH = 3;
/** 最多几位 */
export const TENANT_CODE_MAX_LENGTH = 32;
/** 字符集：小写字母 / 数字 / 连字符 */
export const TENANT_CODE_CHARSET_PATTERN = /^[a-z0-9-]+$/;
/** 带长度约束的完整正则 —— 给前端的 AntD `rules.pattern` 用 */
export const TENANT_CODE_PATTERN = /^[a-z0-9-]{3,32}$/;

/** 前端表单的提示文案（跟正则配套，别单独改一边） */
export const TENANT_CODE_HINT = `${TENANT_CODE_MIN_LENGTH}-${TENANT_CODE_MAX_LENGTH} 位，小写字母 / 数字 / 短横线`;

/** 租户号是否合法（纯逻辑，前后端都能用） */
export function isValidTenantCode(code: string): boolean {
  return (
    code.length >= TENANT_CODE_MIN_LENGTH &&
    code.length <= TENANT_CODE_MAX_LENGTH &&
    TENANT_CODE_CHARSET_PATTERN.test(code)
  );
}
