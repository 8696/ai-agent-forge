import type { ReactElement, ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Layout, Menu, Dropdown, Avatar, Space, Typography } from 'antd';
import type { MenuProps } from 'antd';
import {
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { getCurrentUser } from '../lib/auth';
import { setToken } from '../lib/apiFactory';
import { BrandMark } from '../components/shell/BrandMark';
import { ThemeToggle } from '../components/shell/ThemeToggle';

const { Header, Sider, Content } = Layout;
const { Text } = Typography;

export interface SidebarItem {
  key: string;
  icon?: ReactNode;
  label: string;
  /** 路由前缀 —— 自动判断 active */
  to?: string;
  disabled?: boolean;
  /** tooltip 提示；disabled 时显示 */
  tooltip?: string;
}

interface SharedShellLayoutProps {
  /** 角色标识 —— 用来（1）选中菜单项；（2）鉴权；（3）持久化 sider 折叠状态；（4）角色专属 title 文案 */
  role: 'system' | 'admin' | 'customer';
  /** Sider 折叠状态 localStorage key —— 不传就用默认 `sider:${role}:collapsed` */
  storageKey?: string;
  /** Sider 标题（标题块 + 折叠后只显示图标） */
  brandLabel: string;
  /** role 标签的小字（如 "SaaS 平台方" / "租户后台"）—— 显示在顶栏左侧 */
  roleHint: string;
  /** 侧栏菜单项 */
  sidebarItems: SidebarItem[];
  children?: ReactNode;
}

/**
 * 3 套 Layout 公共骨架 —— 详见 docs/04-a-ui-总则布局与菜单.md §1.1
 *
 * 内容区是弹性列。表格列宽之和可能超过视口，必须让这一列 `minWidth: 0`，
 * 否则表格会把整个页面撑出横向滚动条（弹性子项默认 min-width: auto）。
 */
export function SharedShellLayout(props: SharedShellLayoutProps): ReactElement {
  const location = useLocation();
  const navigate = useNavigate();
  const user = getCurrentUser();
  const storageKey = props.storageKey ?? `sider:${props.role}:collapsed`;
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(storageKey) === '1';
  });

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(storageKey, collapsed ? '1' : '0');
    }
  }, [collapsed, storageKey]);

  const selectedKeys = useMemo<string[]>(() => {
    const path = location.pathname;
    const match = props.sidebarItems
      .filter((it) => it.to !== undefined && path.startsWith(it.to))
      .sort((a, b) => (b.to?.length ?? 0) - (a.to?.length ?? 0));
    return match.length > 0 && match[0] !== undefined ? [match[0].key] : [];
  }, [location.pathname, props.sidebarItems]);

  const onLogout = (): void => {
    setToken(null);
    navigate(`/${props.role}/login`);
  };

  const userMenu: MenuProps['items'] = [
    {
      key: 'info',
      disabled: true,
      label: (
        <div style={{ minWidth: 180, padding: '4px 0' }}>
          <div style={{ fontWeight: 500 }}>{user?.email ?? `${props.role}#${user?.sub.slice(0, 8) ?? '—'}`}</div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {props.roleHint}
          </Text>
        </div>
      ),
    },
    { type: 'divider' },
    {
      key: 'logout',
      icon: <LogoutOutlined />,
      label: '登出',
      onClick: onLogout,
    },
  ];

  const menuItems: MenuProps['items'] = props.sidebarItems.map((it) => {
    const item: NonNullable<MenuProps['items']>[number] = {
      key: it.key,
      icon: it.icon,
      label: it.to !== undefined ? <Link to={it.to}>{it.label}</Link> : it.label,
      disabled: it.disabled === true,
    };
    if (it.disabled === true && it.tooltip !== undefined) {
      item.title = it.tooltip;
    }
    return item;
  });

  const logoBlock = collapsed ? (
    <div
      style={{
        height: 56,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <BrandMark size="sm" text="" />
    </div>
  ) : (
    <div
      style={{
        height: 56,
        padding: '0 16px',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}
    >
      <BrandMark size="md" text="" />
      <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2, minWidth: 0 }}>
        <Text style={{ color: '#fff', fontSize: 15, fontWeight: 600 }}>AgentForge</Text>
        <Text style={{ color: 'rgba(255,255,255,0.55)', fontSize: 11 }} ellipsis>
          {props.brandLabel}
        </Text>
      </div>
    </div>
  );

  return (
    <Layout style={{ height: '100vh', overflow: 'hidden' }}>
      <Sider
        theme="dark"
        collapsible
        collapsed={collapsed}
        trigger={null}
        width={240}
        collapsedWidth={64}
        style={{
          height: '100vh',
          overflow: 'auto',
        }}
      >
        {logoBlock}
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={selectedKeys}
          items={menuItems}
          style={{ borderRight: 0, paddingTop: 8 }}
        />
      </Sider>
      <Layout style={{ minWidth: 0, height: '100vh', overflow: 'hidden' }}>
        <Header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 20px',
            flex: 'none',
            borderBottom: '1px solid rgba(255,255,255,0.06)',
          }}
        >
          <Space size={12} align="center">
            <button
              type="button"
              onClick={() => setCollapsed((v) => !v)}
              aria-label={collapsed ? '展开侧栏' : '折叠侧栏'}
              style={iconBtnStyle}
            >
              {collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            </button>
            <Text style={{ color: 'rgba(255,255,255,0.65)', fontSize: 13 }}>
              {props.roleHint}
            </Text>
          </Space>

          <Space size={4} align="center">
            <ThemeToggle />
            <Dropdown menu={{ items: userMenu }} trigger={['click']} placement="bottomRight">
              <button type="button" aria-label="user" style={userBtnStyle}>
                <Avatar size={28} icon={<UserOutlined />} style={{ background: '#597ef7' }} />
                <span
                  style={{
                    color: 'rgba(255,255,255,0.85)',
                    fontSize: 13,
                    maxWidth: 180,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {user?.email ?? `${user?.sub.slice(0, 8) ?? '—'}`}
                </span>
              </button>
            </Dropdown>
          </Space>
        </Header>
        <Content
          style={{
            padding: 20,
            minWidth: 0,
            overflow: 'auto',
          }}
        >
          {props.children ?? <Outlet />}
        </Content>
      </Layout>
    </Layout>
  );
}

const iconBtnStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'rgba(255,255,255,0.85)',
  cursor: 'pointer',
  padding: 8,
  borderRadius: 6,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 16,
};

const userBtnStyle: React.CSSProperties = {
  ...iconBtnStyle,
  padding: '4px 8px 4px 4px',
  gap: 8,
};
