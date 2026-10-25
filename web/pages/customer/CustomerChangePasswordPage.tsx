import type { ReactElement } from 'react';
import { customerApi } from '../../lib/customerApi';
import { getCurrentUser } from '../../lib/auth';
import { ChangePasswordCard } from '../../components/shell/ChangePasswordCard';

/**
 * 前台用户自助改密 —— docs/12-a §A4
 */
export function CustomerChangePasswordPage(): ReactElement {
  const forced = getCurrentUser()?.must_change_password === true;
  return (
    <ChangePasswordCard
      api={customerApi}
      roleLabel="customer 子系统 · 前台用户"
      title="修改密码"
      description="设置一个只有你知道的新密码"
      afterUrl="/customer"
      forced={forced}
    />
  );
}
