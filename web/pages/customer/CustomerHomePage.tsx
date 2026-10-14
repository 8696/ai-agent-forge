import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Space, Typography } from 'antd';
import { logout, getCurrentUser } from '../../lib/auth';
import { JwtInspector } from '../../components/JwtInspector';
import { customerApi } from '../../lib/customerApi';

const { Title, Paragraph } = Typography;

/**
 * customer 子系统首页（Step 3 占位）—— 租户前台登录后的着陆页
 * 路由：/customer
 * 业务页面在 Step 5+ 落（聊天挂件 / 我的历史 / 偏好设置 ...）
 */
export function CustomerHomePage(): ReactElement {
  const navigate = useNavigate();
  const user = getCurrentUser();
  return (
    <div style={{ maxWidth: 720 }}>
      <Card>
        <Title level={3}>用户中心</Title>
        <Paragraph>
          欢迎，<code>{user?.sub}</code>
          {user?.tenant_id !== undefined && (
            <>
              ；租户：<code>{user.tenant_id}</code>
            </>
          )}
        </Paragraph>
        <Paragraph type="secondary">
          租户 customer 的工作台 —— 业务页面在 Step 5+ 落（聊天挂件 / 我的对话历史 / 偏好 ...）。
        </Paragraph>
        <Space>
          <Button
            onClick={() => {
              logout();
              navigate('/customer/login');
            }}
          >
            登出
          </Button>
        </Space>
      </Card>
      <JwtInspector api={customerApi} mePath="/me" />
    </div>
  );
}
