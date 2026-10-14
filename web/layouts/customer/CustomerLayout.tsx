import type { ReactElement, ReactNode } from 'react';
import { Layout, Menu, Space, Typography } from 'antd';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { getCurrentUser } from '../../lib/auth';
import { setToken } from '../../lib/apiFactory';
import { ActiveModelsFooter } from '../../components/ActiveModelsFooter';

const { Header, Content, Footer } = Layout;
const { Text, Title } = Typography;

/**
 * customer 子系统 Layout（租户前台：customer 角色）
 * - role=customer 才能进
 * - 菜单：聊天 / 我的历史（Step 5+ 落）
 * - 详见 docs/03-技术栈与规范.md §B.5
 */
export function CustomerLayout({ children }: { children?: ReactNode }): ReactElement {
  const location = useLocation();

  if (location.pathname === '/customer/login') {
    return <>{children ?? <Outlet />}</>;
  }

  const user = getCurrentUser();
  if (user === null) {
    window.location.href = '/customer/login';
    return <></>;
  }
  if (user.role !== 'customer') {
    window.location.href = '/';
    return <></>;
  }

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header style={{ display: 'flex', alignItems: 'center', background: '#f0f5ff' }}>
        <Title level={4} style={{ color: '#1677ff', margin: 0, marginRight: 32 }}>
          用户中心
        </Title>
        <Menu
          mode="horizontal"
          selectedKeys={[location.pathname]}
          items={[
            { key: '/customer', label: <Link to="/customer">首页</Link> },
            {
              key: '/customer/chat',
              label: <Link to="/customer/chat">开始聊天</Link>,
              disabled: true,
            },
            {
              key: '/customer/history',
              label: <Link to="/customer/history">我的历史</Link>,
              disabled: true,
            },
          ]}
          style={{ flex: 1, minWidth: 0, background: '#f0f5ff' }}
        />
        <Space>
          <Text>{user.email ?? `customer#${user.sub.slice(0, 8)}`}</Text>
          <a
            onClick={(e) => {
              e.preventDefault();
              setToken(null);
              window.location.href = '/customer/login';
            }}
          >
            登出
          </a>
        </Space>
      </Header>
      <Content style={{ padding: 32, background: '#fafafa' }}>{children ?? <Outlet />}</Content>
      <Footer
        style={{
          textAlign: 'center',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <Text type="secondary">customer 子系统 · 租户 {user.tenant_id?.slice(0, 6)}…</Text>
        <ActiveModelsFooter />
      </Footer>
    </Layout>
  );
}
