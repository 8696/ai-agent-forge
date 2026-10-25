import type { ReactElement } from 'react';
import { adminApi } from '../../lib/adminApi';
import { getCurrentUser } from '../../lib/auth';
import { ChangePasswordCard } from '../../components/shell/ChangePasswordCard';

/**
 * 租户后台自助改密 —— docs/12-a §A4
 *
 * 被平台方重置过密码（must_change_password=true）的账号，
 * 登录后会被强制送到这里 —— 服务端也会挡住除 /me 和 /change-password 外的请求。
 */
export function AdminChangePasswordPage(): ReactElement {
  const forced = getCurrentUser()?.must_change_password === true;
  return (
    <ChangePasswordCard
      api={adminApi}
      roleLabel="admin 子系统 · 租户后台"
      title="修改密码"
      description="设置一个只有你知道的新密码"
      afterUrl="/admin"
      forced={forced}
    />
  );
}
