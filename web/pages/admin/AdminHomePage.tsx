import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Space, Typography } from 'antd';
import { logout, getCurrentUser } from '../../lib/auth';
import { JwtInspector } from '../../components/JwtInspector';
import { adminApi } from '../../lib/adminApi';

const { Title, Paragraph } = Typography;

/**
 * admin 子系统首页（Step 3 占位）—— 租户后台登录后的着陆页
 * 路由：/admin
 * 业务页面在 Step 13 落（Dashboard / Knowledge / Users / ...）
 */
export function AdminHomePage(): ReactElement {
  const navigate = useNavigate();
  const user = getCurrentUser();
  return (
    <div style={{ maxWidth: 720 }}>
      <Card>
        <Title level={3}>租户后台</Title>
        <Paragraph>
          欢迎，<code>{user?.sub}</code>
          {user?.tenant_id !== undefined && (
            <>
              ；租户：<code>{user.tenant_id}</code>
            </>
          )}
        </Paragraph>
        <Paragraph type="secondary">
          租户 admin 的工作台 —— 业务页面在 Step 13 落（11 个管理页）。
        </Paragraph>
        <Space>
          <Button
            onClick={() => {
              logout();
              navigate('/admin/login');
            }}
          >
            登出
          </Button>
        </Space>
      </Card>
      <JwtInspector api={adminApi} mePath="/me" />
    </div>
  );
}
