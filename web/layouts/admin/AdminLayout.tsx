import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Alert } from 'antd';
import { SharedShellLayout } from '../SharedShellLayout';
import { RequireAuth } from '../../components/RequireAuth';
import type { SidebarItem } from '../SharedShellLayout';
import { fetchAlerts, type AdminAlert } from '../../lib/adminConfig';
import { DashboardOutlined, FileSearchOutlined, TeamOutlined, UploadOutlined, SlidersOutlined,
  EditOutlined,
  SettingOutlined,
  LineChartOutlined,
  FundOutlined,
  ExperimentOutlined,
  TrophyOutlined,
  BookOutlined,
  AuditOutlined,
  KeyOutlined,
  ToolOutlined,
  AlertOutlined,
  SwapOutlined,
  PartitionOutlined,
} from '@ant-design/icons';

/**
 * admin 子系统 Layout（租户后台）
 * - role=admin 才能进
 * - 只放已经落地的菜单；未实现的入口不占位
 */
/**
 * admin 侧栏菜单 —— 按 docs/04-a-ui-总则布局与菜单.md §2.2 的分组结构
 *
 * ⚠️ 2026-10-25 补：以前是 16 个平铺条目，规格里是 7 个分组。
 *    「只放已经落地的菜单」—— 规格里的「告警规则」页没做，不占位。
 */
const SIDEBAR: SidebarItem[] = [
  { key: '/admin', icon: <DashboardOutlined />, label: '首页', to: '/admin' },
  {
    key: 'group-knowledge',
    icon: <FileSearchOutlined />,
    label: '知识库',
    children: [
      {
        key: '/admin/knowledge/documents',
        icon: <UploadOutlined />,
        label: '文档管理',
        to: '/admin/knowledge/documents',
      },
      {
        key: '/admin/knowledge/test',
        icon: <FileSearchOutlined />,
        label: '检索测试',
        to: '/admin/knowledge/test',
      },
      {
        key: '/admin/knowledge/chunks',
        icon: <PartitionOutlined />,
        label: '切片浏览',
        to: '/admin/knowledge/chunks',
      },
    ],
  },
  {
    key: 'group-model',
    icon: <SlidersOutlined />,
    label: '模型 & 提示词',
    children: [
      {
        key: '/admin/models',
        icon: <SlidersOutlined />,
        label: '模型选择',
        to: '/admin/models',
      },
      {
        key: '/admin/prompts',
        icon: <EditOutlined />,
        label: '提示词配置',
        to: '/admin/prompts',
      },
    ],
  },
  {
    key: 'group-tools',
    icon: <ToolOutlined />,
    label: '工具',
    children: [
      {
        key: '/admin/tools',
        icon: <ToolOutlined />,
        label: '工具列表',
        to: '/admin/tools',
      },
      {
        key: '/admin/tool-logs',
        icon: <FileSearchOutlined />,
        label: '调用记录',
        to: '/admin/tool-logs',
      },
    ],
  },
  {
    key: 'group-evaluation',
    icon: <ExperimentOutlined />,
    label: '评测',
    children: [
      {
        key: '/admin/evaluation/datasets',
        icon: <ExperimentOutlined />,
        label: '评测集',
        to: '/admin/evaluation/datasets',
      },
      {
        key: '/admin/evaluation/runs',
        icon: <TrophyOutlined />,
        label: '评测结果',
        to: '/admin/evaluation/runs',
      },
      {
        key: '/admin/evaluation/compare',
        icon: <SwapOutlined />,
        label: '版本对比',
        to: '/admin/evaluation/compare',
      },
    ],
  },
  {
    key: 'group-observability',
    icon: <LineChartOutlined />,
    label: '观测',
    children: [
      {
        key: '/admin/observability/traces',
        icon: <LineChartOutlined />,
        label: 'Trace 列表',
        to: '/admin/observability/traces',
      },
      {
        key: '/admin/observability/cost',
        icon: <FundOutlined />,
        label: '成本分析',
        to: '/admin/observability/cost',
      },
      {
        key: '/admin/observability/alerts',
        icon: <AlertOutlined />,
        label: '告警规则',
        to: '/admin/observability/alerts',
      },
    ],
  },
  {
    key: 'group-users',
    icon: <TeamOutlined />,
    label: '用户',
    children: [
      { key: '/admin/users', icon: <TeamOutlined />, label: '用户列表', to: '/admin/users' },
      {
        key: '/admin/memories',
        icon: <BookOutlined />,
        label: '用户记忆',
        to: '/admin/memories',
      },
      {
        key: '/admin/audit',
        icon: <AuditOutlined />,
        label: '操作审计',
        to: '/admin/audit',
      },
    ],
  },
  {
    key: 'group-settings',
    icon: <SettingOutlined />,
    label: '设置',
    children: [
      {
        key: '/admin/settings',
        icon: <SettingOutlined />,
        label: '租户配置',
        to: '/admin/settings',
      },
      {
        key: '/admin/api-keys',
        icon: <KeyOutlined />,
        label: 'API 密钥',
        to: '/admin/api-keys',
      },
    ],
  },
];

export function AdminLayout(): ReactElement {
  const location = useLocation();

  // 登录页：整屏（AuthShell 自带整页背景），不套后台外壳
  if (location.pathname === '/admin/login') {
    return <Outlet />;
  }

  // ⚠️ 改密页**仍然要过 RequireAuth**（2026-10-27 修）：
  // 以前这里是 `return <Outlet />` 直接放行 → 没登录的人能进改密页，
  // 提交后拿到 401，又因为「所有 change-password 的 401 都豁免」而被显示成
  // 「原密码不正确」→ 用户彻底懵。
  //
  // 「强制改密」不会死循环：RequireAuth 只在 `location.pathname !== changePasswordPath`
  // 时才跳改密页（改密页自己不在跳转条件里）。
  if (location.pathname === '/admin/change-password') {
    return (
      <RequireAuth
        role="admin"
        loginPath="/admin/login"
        changePasswordPath="/admin/change-password"
      >
        <Outlet />
      </RequireAuth>
    );
  }

  return (
    <RequireAuth role="admin" loginPath="/admin/login" changePasswordPath="/admin/change-password">
      <SharedShellLayout
        role="admin"
        brandLabel="租户后台"
        roleHint="租户后台"
        sidebarItems={SIDEBAR}
      >
        <AlertBanner />
        <Outlet />
      </SharedShellLayout>
    </RequireAuth>
  );
}

/**
 * 顶部告警条 —— D3 / D4 / D5（docs/09-观测方案.md §9.4「控制台告警条」）
 *
 * 三类信号：成本超预算、限流命中、安全拦截。
 * 拉不到就当没有（后台不该因为告警接口挂了就整个打不开）。
 */
function AlertBanner(): ReactElement | null {
  const [alerts, setAlerts] = useState<AdminAlert[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await fetchAlerts();
        if (!cancelled) {
          setAlerts(data);
        }
      } catch {
        // 拿不到就不显示
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (alerts.length === 0) {
    return null;
  }

  return (
    <div style={{ marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {alerts.map((a) => (
        <Alert key={a.id} type={a.level} showIcon title={a.title} description={a.detail} />
      ))}
    </div>
  );
}

