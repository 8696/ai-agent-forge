import type { ReactElement } from 'react';
import { Typography } from 'antd';
import { getCurrentUser } from '../../lib/auth';
import { PageHeader } from '../../components/shell/PageHeader';

const { Text } = Typography;

export function CustomerHomePage(): ReactElement {
  const user = getCurrentUser();

  return (
    <PageHeader
      title="用户中心"
      subtitle={
        <>
          欢迎，<Text strong>{user?.email ?? user?.sub}</Text>
          。聊天功能还没开放。
        </>
      }
    />
  );
}
