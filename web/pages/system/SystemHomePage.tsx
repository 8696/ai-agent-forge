import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Space, Typography } from 'antd';
import { logout, getCurrentUser } from '../../lib/auth';
import { JwtInspector } from '../../components/JwtInspector';
import { systemApi } from '../../lib/systemApi';

const { Title, Paragraph } = Typography;

/**
 * system 子系统首页（Step 3 占位）—— SaaS 平台方登录后的着陆页
 * 路由：/system
 * 业务页面在 Step 13+ 落
 */
export function SystemHomePage(): ReactElement {
  const navigate = useNavigate();
  const user = getCurrentUser();
  return (
    <div style={{ maxWidth: 720 }}>
      <Card>
        <Title level={3}>平台管理</Title>
        <Paragraph>
          欢迎，<code>{user?.sub}</code>
        </Paragraph>
        <Paragraph type="secondary">
          SaaS 平台方的工作台（建租户 / 跨租户运营）—— 业务页面在 Step 13+ 落地。
        </Paragraph>
        <Space>
          <Button
            onClick={() => {
              logout();
              navigate('/system/login');
            }}
          >
            登出
          </Button>
        </Space>
      </Card>
      <JwtInspector api={systemApi} mePath="/me" />
    </div>
  );
}
