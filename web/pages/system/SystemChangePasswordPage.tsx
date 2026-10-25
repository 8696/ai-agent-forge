import type { ReactElement } from 'react';
import { systemApi } from '../../lib/systemApi';
import { ChangePasswordCard } from '../../components/shell/ChangePasswordCard';

/**
 * 平台方自助改密 —— docs/12-a §A4
 *
 * ⚠️ system 用户没有 must_change_password 字段（`system_users` 表里没有），
 *    所以这里**永远是普通改密**，不是强制流程。
 */
export function SystemChangePasswordPage(): ReactElement {
  return (
    <ChangePasswordCard
      api={systemApi}
      roleLabel="system 子系统 · SaaS 平台方"
      title="修改密码"
      description="设置一个只有你知道的新密码"
      afterUrl="/system"
      forced={false}
    />
  );
}
