import type { ReactElement, ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Layout, Menu, Dropdown, Avatar, Drawer, Space, Typography, theme } from 'antd';
import type { MenuProps } from 'antd';
import {
  KeyOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { getCurrentUser } from '../lib/auth';
import { setToken } from '../lib/apiFactory';
import { BrandMark } from '../components/shell/BrandMark';
import { ActiveModelsFooter } from '../components/ActiveModelsFooter';
import { ThemeToggle } from '../components/shell/ThemeToggle';

const { Header, Sider, Content, Footer } = Layout;
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
  /**
   * 子项 —— 有子项的渲染成**分组**（可折叠的二级菜单）。
   *
   * ⚠️ 2026-10-25 补：以前侧栏是 16 个平铺条目（04-a §2.2 规格里是 7 个分组），
   *    菜单一长就不好找。现在支持分组了。
   */
  children?: SidebarItem[];
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
  // 颜色走 antd token —— 写死浅色的话，深色模式下几乎看不见
  const { token } = theme.useToken();
  const storageKey = props.storageKey ?? `sider:${props.role}:collapsed`;
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(storageKey) === '1';
  });
  // 窄屏（< 992px）自动折叠侧栏（docs/04-d §9.2 响应式断点）。
  //
  // ⚠️ **单独一个状态，不去改 `collapsed`** —— 那会把用户手动折叠的偏好也冲掉
  //    （切回宽屏时侧栏还缩着，用户得再点一次）。这里只做「窄屏时强制折叠」。
  const [isNarrow, setIsNarrow] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(max-width: 992px)').matches;
  });
  /**
   * 窄屏时侧栏是**浮层抽屉**的开关（2026-10-27 修）。
   *
   * ⚠️ 以前窄屏时 `effectiveCollapsed` 恒为 true，而折叠按钮只翻转 `collapsed`
   *    → 点了纹丝不动（实测 900px 宽下 sider 宽度 64 → 64）。
   *    现在窄屏点按钮是**打开抽屉**（浮层 + 遮罩 + 点遮罩关闭），
   *    宽屏（≥992px）行为不变（折叠/展开插在内容区左侧）。
   */
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(max-width: 992px)');
    const onChange = (e: MediaQueryListEvent): void => setIsNarrow(e.matches);
    setIsNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // 切回宽屏 → 抽屉收起来（别留一个浮层挡着内容）
  useEffect(() => {
    if (!isNarrow) setDrawerOpen(false);
  }, [isNarrow]);

  // 窄屏下抽屉里选了菜单 → 关掉抽屉（否则盖着新页面）
  useEffect(() => {
    setDrawerOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  /**
   * 实际折叠状态。
   *
   * ⚠️ **窄屏时恒为 false** —— 窄屏的侧栏是浮层抽屉，抽屉里永远是展开的
   *    （折叠成 64px 的图标条在浮层里没法点）。
   */
  const effectiveCollapsed = isNarrow ? false : collapsed;

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(storageKey, collapsed ? '1' : '0');
    }
  }, [collapsed, storageKey]);

  const selectedKeys = useMemo<string[]>(() => {
    const path = location.pathname;
    // 分组里的子项也要参与匹配（用户可能在子页面里）
    const flat = props.sidebarItems.flatMap((it) =>
      it.children !== undefined && it.children.length > 0 ? it.children : [it],
    );
    const match = flat
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
      // ⚠️ 2026-10-25 补：以前**没有任何入口**能进改密页 ——
      //    路由存在、RequireAuth 也会跳过去，但用户找不到地方点。
      key: 'change-password',
      icon: <KeyOutlined />,
      label: '修改密码',
      onClick: () => navigate(`/${props.role}/change-password`),
    },
    {
      key: 'logout',
      icon: <LogoutOutlined />,
      label: '登出',
      onClick: onLogout,
    },
  ];

  const leafItem = (it: SidebarItem): NonNullable<MenuProps['items']>[number] => {
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
  };

  const menuItems: MenuProps['items'] = props.sidebarItems.map((it) => {
    if (it.children !== undefined && it.children.length > 0) {
      // 分组：antd 的二级菜单。折叠状态下只显示图标（点开是浮层）
      return {
        key: it.key,
        icon: it.icon,
        label: it.label,
        children: it.children.map(leafItem),
      };
    }
    return leafItem(it);
  });

  const logoBlock = effectiveCollapsed ? (
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

  const siderContent = (
    <>
      {logoBlock}
      <Menu
        theme="dark"
        mode="inline"
        selectedKeys={selectedKeys}
        items={menuItems}
        onClick={() => {
          // 窄屏：抽屉里选了菜单 → 关掉抽屉（否则浮层盖着新页面）
          if (isNarrow) setDrawerOpen(false);
        }}
        style={{ borderRight: 0, paddingTop: 8 }}
      />
    </>
  );

  return (
    <Layout style={{ height: '100vh', overflow: 'hidden' }}>
      {isNarrow ? (
        /* 窄屏：侧栏是**浮层抽屉**（docs/04-d §9.2「后台在 < 992px 自动折叠 Sider」）。
           以前这里是把侧栏插在内容区左边再压成 64px 的图标条 ——
           折叠按钮点了没反应，用户根本打不开菜单。
           浮层抽屉的体验才对：点按钮 → 抽屉从左边滑出来 + 遮罩，
           点遮罩关闭，抽屉打开时锁定 body 滚动（antd Drawer 自带）。 */
        <Drawer
          placement="left"
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          closable={false}
          size={240}
          mask={{ closable: true }}
          styles={{ body: { padding: 0, background: token.colorBgContainer } }}
        >
          <Sider
            theme="dark"
            collapsed={false}
            trigger={null}
            width={240}
            style={{ height: '100%', overflow: 'auto' }}
          >
            {siderContent}
          </Sider>
        </Drawer>
      ) : (
        <Sider
          theme="dark"
          collapsible
          collapsed={effectiveCollapsed}
          trigger={null}
          width={240}
          collapsedWidth={64}
          style={{
            height: '100vh',
            overflow: 'auto',
          }}
        >
          {siderContent}
        </Sider>
      )}
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
              // 窄屏 → 开关浮层抽屉；宽屏 → 折叠/展开插在内容区左侧
              onClick={() => {
                if (isNarrow) {
                  setDrawerOpen((v) => !v);
                } else {
                  setCollapsed((v) => !v);
                }
              }}
              aria-label={
                isNarrow
                  ? drawerOpen
                    ? '关闭侧栏'
                    : '打开侧栏'
                  : effectiveCollapsed
                    ? '展开侧栏'
                    : '折叠侧栏'
              }
              style={iconBtnStyle}
            >
              {isNarrow || effectiveCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
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
        {/* 页脚：当前生效的 LLM / Embedding 模型（docs/04-d §7.4）。
            运营方在这就能确认 `LLM_PROVIDER` 切到对的地方了。 */}
        <Footer
          style={{
            padding: '10px 20px',
            textAlign: 'center',
          }}
        >
          <ActiveModelsFooter />
        </Footer>
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
