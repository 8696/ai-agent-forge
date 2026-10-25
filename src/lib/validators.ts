import { z } from 'zod';

/**
 * 通用 Zod schemas —— 与 docs/16-需求技术对照表 A2 / A3 关键代码段一致
 *
 * 租户号规则（16 §A2）：[a-z0-9-]{3,32}，全小写、允许数字 + 连字符
 * 角色：3 个取值（admin / agent / customer）
 */

export const tenantCodeSchema = z
  .string()
  .min(3)
  .max(32)
  .regex(/^[a-z0-9-]+$/, '租户号只能包含小写字母 / 数字 / 连字符');

export const roleSchema = z.enum(['admin', 'customer']);

export const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, '密码至少 8 字符'),
  role: roleSchema,
});

export const updateUserSchema = z
  .object({
    email: z.string().email().optional(),
    password: z.string().min(8).optional(),
    /**
     * 改角色（04-c §5.8「[编辑用户] 抽屉：邮箱 / 角色 / 重置密码」）。
     * 仍然拒收 `agent` —— 本产品没有「后台客服坐席」这个角色。
     */
    role: roleSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '至少要改一个字段' });

export const changePasswordSchema = z.object({
  old_password: z.string().min(1),
  new_password: z.string().min(8, '新密码至少 8 字符'),
});

export const createTenantSchema = z.object({
  code: tenantCodeSchema,
  name: z.string().min(1).max(200),
  admin_email: z.string().email(),
  admin_password: z.string().min(8, '初始管理员密码至少 8 字符'),
  /**
   * 套餐（04-d §6.1「创建租户」表单里有这一项）。
   * 不传 = free（数据库默认值）。
   */
  plan: z.enum(['free', 'pro', 'enterprise']).optional(),
  /**
   * 到期时间（ISO8601）；不传 / null = 永不过期（04-d §6.1 同上）。
   */
  expires_at: z.string().datetime({ offset: true }).nullish(),
});

// F1 · System 端租户管理
export const updateTenantSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    plan: z.enum(['free', 'pro', 'enterprise']).optional(),
  })
  .refine((v) => v.name !== undefined || v.plan !== undefined, {
    message: '至少要改一个字段',
  });

export const resetTenantAdminPasswordSchema = z.object({
  new_password: z.string().min(8, '新密码至少 8 字符'),
});

/**
 * F2 · System 端租户启停 / 到期时间
 * 详见 docs/12-e-需求-业务接入与平台运营.md F2 + docs/03-b-技术栈-后端栈.md §6.1.1
 *
 * expires_at 既接受 ISO 8601 字符串（含时区），也接受 null（=清空到期限制 = 永不过）。
 *   例如：'2026-12-31T15:00:00Z' / '2026-12-31T15:00:00+08:00' / null
 *
 * status 取值严格收窄为 'active' | 'disabled'。
 */
export const updateTenantExpiresAtSchema = z.object({
  expires_at: z.string().datetime({ offset: true }).nullable(),
});

export const updateTenantStatusSchema = z.object({
  status: z.enum(['active', 'disabled']),
});
