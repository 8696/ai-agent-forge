import type { ReactElement } from 'react';
import { Card, Typography } from 'antd';
import { RightOutlined, ShopOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { getCurrentUser } from '../../lib/auth';
import { PageHeader } from '../../components/shell/PageHeader';

const { Text } = Typography;

export function SystemHomePage(): ReactElement {
  const user = getCurrentUser();

  return (
    <div>
      <PageHeader
        title="平台管理"
        subtitle={<>欢迎，<Text strong>{user?.email ?? user?.sub}</Text></>}
      />
      <Link to="/system/tenants" style={{ display: 'block', maxWidth: 420 }}>
        <Card hoverable styles={{ body: { padding: '18px 20px' } }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <ShopOutlined style={{ color: '#2f54eb', fontSize: 18 }} />
            <Text strong style={{ fontSize: 15, flex: 1 }}>
              租户管理
            </Text>
            <RightOutlined style={{ color: 'rgba(0,0,0,0.45)' }} />
          </div>
          <Text type="secondary">创建租户、修改到期时间、启用或禁用。</Text>
        </Card>
      </Link>
    </div>
  );
}
