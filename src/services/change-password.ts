/**
 * 改密码 —— docs/12-a-需求-多租户与登录.md §A4
 *
 * A4 的验收里明写着「改密码（admin 自己改 + 改后 me 仍 OK）= 2」，
 * 而 `must_change_password` 这个字段从建表起就在（平台方重置租户 admin 密码时
 * 置 true），**却一直没人消费** —— 改了等于没改，用户拿着平台方给的临时密码
 * 长期用下去。
 *
 * 这份逻辑被 admin / customer / system 三个子系统共用（改密码这件事没有区别），
 * 但**端点各归各**（`/api/v1/{admin,customer,system}/change-password`）——
 * 子系统自闭环是 A4 的硬要求，不能为了省代码就合并。
 */

import { AuthError, ValidationError } from '../lib/errors';
import { hashPassword, verifyPassword } from '../lib/password';

/** 能被改密码的账号（`User` 和 `SystemUser` 都满足这个形状） */
interface PasswordBearing {
  password_hash: string | null;
  /** `SystemUser` 没有这个字段 —— 可选 */
  must_change_password?: boolean;
  save: () => Promise<unknown>;
}

/**
 * 校验旧密码并写入新密码。
 *
 * @param row            账号行（`User` 或 `SystemUser`）
 * @param oldPassword    旧密码（明文）
 * @param newPassword    新密码（明文，已过长度校验）
 */
export async function changePasswordFor(
  row: PasswordBearing,
  oldPassword: string,
  newPassword: string,
): Promise<void> {
  if (row.password_hash === null) {
    // 账号没有密码（只能走别的登录方式）—— 不泄露具体原因
    throw new AuthError('邮箱或密码错误');
  }
  const ok = await verifyPassword(oldPassword, row.password_hash);
  if (!ok) {
    throw new AuthError('原密码不正确');
  }
  if (oldPassword === newPassword) {
    throw new ValidationError('新密码不能跟原密码一样');
  }
  row.password_hash = await hashPassword(newPassword);
  // 改完就把「必须改密」这个标记清掉 —— 否则下次登录又被拦
  if (row.must_change_password !== undefined) {
    row.must_change_password = false;
  }
  await row.save();
}
