import type { ReactElement, ReactNode } from 'react';
import { Layout, Menu, Space, Typography } from 'antd';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { getCurrentUser } from '../../lib/auth';
import { setToken } from '../../lib/apiFactory';
import { ActiveModelsFooter } from '../../components/ActiveModelsFooter';

const { Header, Content, Footer } = Layout;
const { Text, Title } = Typography;

/**
 * admin 子系统 Layout（租户后台）
 * - role=admin 才能进
 * - 菜单：Dashboard / 知识库 / 用户 / 评测 / Trace / 成本 / 设置（Step 13 落）
 * - 详见 docs/03-技术栈与规范.md §B.5
 */
export function AdminLayout({ children }: { children?: ReactNode }): ReactElement {
  const location = useLocation();

  if (location.pathname === '/admin/login') {
    return <>{children ?? <Outlet />}</>;
  }

  const user = getCurrentUser();
  if (user === null) {
    window.location.href = '/admin/login';
    return <></>;
  }
  if (user.role !== 'admin') {
    window.location.href = '/';
    return <></>;
  }

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header style={{ display: 'flex', alignItems: 'center', background: '#001529' }}>
        <Title level={4} style={{ color: '#fff', margin: 0, marginRight: 32 }}>
          租户后台
        </Title>
        <Menu
          theme="dark"
          mode="horizontal"
          selectedKeys={[location.pathname]}
          items={[
            { key: '/admin', label: <Link to="/admin">首页</Link> },
            {
              key: '/admin/knowledge/documents',
              label: <Link to="/admin/knowledge/documents">知识库</Link>,
            },
            { key: '/admin/knowledge/test', label: <Link to="/admin/knowledge/test">检索测试</Link> },
            { key: '/admin/users', label: <Link to="/admin/users">用户</Link> },
            { key: '/admin/eval', label: <Link to="/admin/eval">评测</Link>, disabled: true },
            { key: '/admin/traces', label: <Link to="/admin/traces">Trace</Link>, disabled: true },
            { key: '/admin/cost', label: <Link to="/admin/cost">成本</Link>, disabled: true },
          ]}
          style={{ flex: 1, minWidth: 0 }}
        />
        <Space>
          <Text style={{ color: '#fff' }}>{user.email ?? `admin#${user.sub.slice(0, 8)}`}</Text>
          <a
            style={{ color: '#69b1ff' }}
            onClick={(e) => {
              e.preventDefault();
              setToken(null);
              window.location.href = '/admin/login';
            }}
          >
            登出
          </a>
        </Space>
      </Header>
      <Content style={{ padding: 32, background: '#f5f5f5' }}>{children ?? <Outlet />}</Content>
      <Footer
        style={{
          textAlign: 'center',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <Text type="secondary">admin 子系统 · 租户 {user.tenant_id?.slice(0, 6)}…</Text>
        <ActiveModelsFooter />
      </Footer>
    </Layout>
  );
}
