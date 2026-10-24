import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { Alert, Button, Card, Col, Empty, Row, Table, Tag, Typography, theme } from 'antd';
import type { TableColumnsType } from 'antd';
import { ReloadOutlined, RightOutlined, ShopOutlined } from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import { Link } from 'react-router-dom';
import { getCurrentUser } from '../../lib/auth';
import { fetchSystemStats, type SystemStats } from '../../lib/systemApi';
import { PageHeader } from '../../components/shell/PageHeader';

const { Text } = Typography;

/**
 * /system —— 平台方总览（docs/04-d-ui-系统级与公共组件.md §6.2）
 *
 * 跨租户 KPI：租户数 / 用户数 / 今日对话与成本 / 7 天趋势 / 本月超预算的租户。
 * 数据来自 GET /api/v1/system/stats —— **只有 system 角色能拿到**这个口径。
 */
export function SystemHomePage(): ReactElement {
  const user = getCurrentUser();
  const { token } = theme.useToken();
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async (): Promise<void> => {
    setLoading(true);
    setErrMsg(null);
    try {
      setStats(await fetchSystemStats());
    } catch (err: unknown) {
      setStats(null);
      const e = err as { response?: { status?: number; data?: { message?: string } } };
      setErrMsg(
        e.response?.status === 401
          ? '鉴权失败（需 system 角色）'
          : (e.response?.data?.message ?? '加载平台统计失败'),
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const trendOption = {
    tooltip: { trigger: 'axis' },
    grid: { left: 60, right: 20, top: 30, bottom: 40 },
    xAxis: { type: 'category', data: (stats?.trend ?? []).map((t) => t.date) },
    yAxis: [
      { type: 'value', name: '对话数' },
      { type: 'value', name: '花费 (USD)', axisLabel: { formatter: (v: number) => `$${v}` } },
    ],
    series: [
      {
        name: '对话数',
        type: 'line',
        data: (stats?.trend ?? []).map((t) => t.conversations),
        itemStyle: { color: '#1677ff' },
      },
      {
        name: '花费',
        type: 'bar',
        yAxisIndex: 1,
        data: (stats?.trend ?? []).map((t) => t.cost),
        itemStyle: { color: '#52c41a' },
      },
    ],
  };

  const overBudgetColumns: TableColumnsType<SystemStats['over_budget'][number]> = [
    { title: '租户号', dataIndex: 'code', key: 'code', width: 140, ellipsis: true },
    { title: '名称', dataIndex: 'name', key: 'name', ellipsis: true },
    {
      title: '本月已用',
      dataIndex: 'used',
      key: 'used',
      width: 140,
      render: (v: number) => v.toLocaleString('zh-CN'),
    },
    {
      title: '预算',
      dataIndex: 'limit',
      key: 'limit',
      width: 140,
      render: (v: number) => v.toLocaleString('zh-CN'),
    },
    {
      title: '超出',
      key: 'ratio',
      width: 100,
      render: (_: unknown, row) => (
        <Tag color="error" style={{ fontWeight: 500 }}>
          {Math.round((row.used / row.limit) * 100)}%
        </Tag>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="平台管理"
        subtitle={
          <>
            欢迎，<Text strong>{user?.email ?? user?.sub}</Text> —— 这里是全平台视角（跨租户）。
          </>
        }
        extra={
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>
            刷新
          </Button>
        }
      />

      {errMsg !== null && (
        <Alert type="error" showIcon title={errMsg} style={{ marginBottom: 16 }} />
      )}

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={12} sm={12} lg={6}>
          <StatCard
            label="总租户数"
            value={stats === null ? '—' : String(stats.tenants.total)}
            extra={
              stats === null
                ? undefined
                : `启用 ${stats.tenants.active} · 禁用 ${stats.tenants.disabled} · 已到期 ${stats.tenants.expired}`
            }
          />
        </Col>
        <Col xs={12} sm={12} lg={6}>
          <StatCard
            label="总用户数"
            value={stats === null ? '—' : stats.users.tenant_users.toLocaleString('zh-CN')}
            extra={stats === null ? undefined : `平台账号 ${stats.users.system_users} 个`}
          />
        </Col>
        <Col xs={12} sm={12} lg={6}>
          <StatCard
            label="今日对话数"
            value={stats === null ? '—' : stats.today.conversations.toLocaleString('zh-CN')}
            extra={
              stats === null
                ? undefined
                : `错误率 ${(stats.today.error_rate * 100).toFixed(1)}% · ${stats.today.errors} 次失败`
            }
          />
        </Col>
        <Col xs={12} sm={12} lg={6}>
          <StatCard
            label="今日成本"
            value={stats === null ? '—' : `$${stats.today.cost.toFixed(4)}`}
            extra={
              stats === null
                ? undefined
                : `${stats.today.total_tokens.toLocaleString('zh-CN')} token`
            }
          />
        </Col>
      </Row>

      <Card title="最近 7 天趋势" style={{ marginBottom: 16 }}>
        {stats === null ? (
          <div style={{ height: 280 }} />
        ) : stats.trend.length === 0 ? (
          <Empty description="最近 7 天还没有 LLM 调用记录" />
        ) : (
          <ReactECharts option={trendOption} style={{ height: 280 }} notMerge />
        )}
      </Card>

      <Card title="成本超预算的租户" style={{ marginBottom: 16 }}>
        <Table
          rowKey="tenant_id"
          columns={overBudgetColumns}
          dataSource={stats?.over_budget ?? []}
          loading={loading}
          pagination={false}
          tableLayout="fixed"
          locale={{
            emptyText:
              stats === null ? '加载中…' : '没有租户超预算（只有显式配过月度预算的租户才会被检查）',
          }}
        />
      </Card>

      <Link to="/system/tenants" style={{ display: 'block', maxWidth: 420 }}>
        <Card hoverable styles={{ body: { padding: '18px 20px' } }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <ShopOutlined style={{ color: '#2f54eb', fontSize: 18 }} />
            <Text strong style={{ fontSize: 15, flex: 1 }}>
              租户管理
            </Text>
            <RightOutlined style={{ color: token.colorTextQuaternary }} />
          </div>
          <Text type="secondary">创建租户、修改到期时间、启用或禁用。</Text>
        </Card>
      </Link>
    </div>
  );
}

function StatCard({
  label,
  value,
  extra,
}: {
  label: string;
  value: string;
  extra?: string | undefined;
}): ReactElement {
  return (
    <Card styles={{ body: { padding: '18px 20px' } }}>
      <Text type="secondary" style={{ fontSize: 12 }}>
        {label}
      </Text>
      <div style={{ fontSize: 26, fontWeight: 600, lineHeight: 1.35 }}>{value}</div>
      {extra !== undefined && (
        <Text type="secondary" style={{ fontSize: 12 }}>
          {extra}
        </Text>
      )}
    </Card>
  );
}
