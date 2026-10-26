import type { User, SystemUser } from '../models';
import { AuthError } from './errors';

/**
 * 登录失败锁定策略（docs/12-a §A4）
 * - 连续 5 次失败 → 锁定 15 分钟
 * - 锁定期间返回统一 401 "邮箱或密码错误"（不暴露账号被锁）
 * - 任意一次成功 → 计数清零 + 锁定清空
 */

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_DURATION_MIN = 15;

export function isAccountLocked(lockedUntil: Date | null): boolean {
  if (lockedUntil === null) return false;
  return lockedUntil.getTime() > Date.now();
}

export function throwIfLocked(user: { locked_until: Date | null }): void {
  if (isAccountLocked(user.locked_until)) {
    throw new AuthError('邮箱或密码错误');
  }
}

export async function recordFailedLogin(user: User | SystemUser): Promise<void> {
  user.failed_login_count = (user.failed_login_count ?? 0) + 1;
  if (user.failed_login_count >= MAX_FAILED_ATTEMPTS) {
    user.locked_until = new Date(Date.now() + LOCK_DURATION_MIN * 60_000);
  }
  await user.save();
}

export async function recordSuccessfulLogin(user: User | SystemUser): Promise<void> {
  user.failed_login_count = 0;
  user.locked_until = null;
  user.last_login_at = new Date();
  await user.save();
}
