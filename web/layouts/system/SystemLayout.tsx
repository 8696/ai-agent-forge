import type { ReactElement, ReactNode } from 'react';
import { Layout, Menu, Space, Typography } from 'antd';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { getCurrentUser } from '../../lib/auth';
import { setToken } from '../../lib/apiFactory';

const { Header, Content, Footer } = Layout;
const { Text, Title } = Typography;

/**
 * system 子系统 Layout（SaaS 平台方后台）
 * - role=system 才能进，否则 401 重定向
 * - 菜单：租户管理 / 平台设置（具体业务等 Step 13+ 落）
 * - 详见 docs/03-技术栈与规范.md §B.5
 */
export function SystemLayout({ children }: { children?: ReactNode }): ReactElement {
  const location = useLocation();

  // system 端点（如 login 页面）不走 auth guard
  if (location.pathname === '/system/login') {
    return <>{children ?? <Outlet />}</>;
  }

  const user = getCurrentUser();
  if (user === null) {
    window.location.href = '/system/login';
    return <></>;
  }
  if (user.role !== 'system') {
    window.location.href = '/';
    return <></>;
  }

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header style={{ display: 'flex', alignItems: 'center', background: '#1f1f1f' }}>
        <Title level={4} style={{ color: '#fff', margin: 0, marginRight: 32 }}>
          AgentForge · 平台管理
        </Title>
        <Menu
          theme="dark"
          mode="horizontal"
          selectedKeys={[location.pathname]}
          items={[
            { key: '/system', label: <Link to="/system">首页</Link> },
            { key: '/system/tenants', label: <Link to="/system/tenants">租户管理</Link> },
          ]}
          style={{ flex: 1, minWidth: 0, background: '#1f1f1f' }}
        />
        <Space>
          <Text style={{ color: '#fff' }}>{user.email ?? `system#${user.sub.slice(0, 8)}`}</Text>
          <a
            style={{ color: '#69b1ff' }}
            onClick={(e) => {
              e.preventDefault();
              setToken(null);
              window.location.href = '/system/login';
            }}
          >
            登出
          </a>
        </Space>
      </Header>
      <Content style={{ padding: 32, background: '#f5f5f5' }}>{children ?? <Outlet />}</Content>
      <Footer style={{ textAlign: 'center' }}>
        <Text type="secondary">system 子系统 · SaaS 平台方</Text>
      </Footer>
    </Layout>
  );
}
