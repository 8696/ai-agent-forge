import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { Alert } from 'antd';
import { SharedShellLayout } from '../SharedShellLayout';
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
} from '@ant-design/icons';

/**
 * admin 子系统 Layout（租户后台）
 * - role=admin 才能进
 * - 只放已经落地的菜单；未实现的入口不占位
 */
const SIDEBAR: SidebarItem[] = [
  { key: '/admin', icon: <DashboardOutlined />, label: '首页', to: '/admin' },
  { key: '/admin/users', icon: <TeamOutlined />, label: '用户', to: '/admin/users' },
  {
    key: '/admin/memories',
    icon: <BookOutlined />,
    label: '用户记忆',
    to: '/admin/memories',
  },
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
  {
    key: '/admin/settings',
    icon: <SettingOutlined />,
    label: '租户设置',
    to: '/admin/settings',
  },
  {
    key: '/admin/observability/traces',
    icon: <LineChartOutlined />,
    label: '观测',
    to: '/admin/observability/traces',
  },
  {
    key: '/admin/observability/cost',
    icon: <FundOutlined />,
    label: '成本分析',
    to: '/admin/observability/cost',
  },
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
    key: '/admin/api-keys',
    icon: <KeyOutlined />,
    label: 'API 密钥',
    to: '/admin/api-keys',
  },
  {
    key: '/admin/audit',
    icon: <AuditOutlined />,
    label: '审计日志',
    to: '/admin/audit',
  },
];

export function AdminLayout(): ReactElement {
  const location = useLocation();

  if (location.pathname === '/admin/login') {
    return <Outlet />;
  }

  if (typeof window !== 'undefined') {
    const token = window.localStorage.getItem('agent_platform_token');
    if (token === null) {
      return <Navigate to="/admin/login" replace />;
    }
    const roleFromToken = readRoleFromToken(token);
    if (roleFromToken !== null && roleFromToken !== 'admin') {
      return <Navigate to="/" replace />;
    }
  }

  return (
    <SharedShellLayout
      role="admin"
      brandLabel="租户后台"
      roleHint="租户后台"
      sidebarItems={SIDEBAR}
    >
      <AlertBanner />
      <Outlet />
    </SharedShellLayout>
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
        <Alert key={a.id} type={a.level} showIcon message={a.title} description={a.detail} />
      ))}
    </div>
  );
}

function readRoleFromToken(token: string): string | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1] ?? '')) as { role?: unknown };
    return typeof payload.role === 'string' ? payload.role : null;
  } catch {
    return null;
  }
}
