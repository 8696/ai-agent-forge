import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { Alert, Button, Card, Col, Empty, Row, Table, Typography, theme } from 'antd';
import type { TableColumnsType } from 'antd';
import { ReloadOutlined, RightOutlined, ShopOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { getCurrentUser } from '../../lib/auth';
import { fetchSystemStats, type SystemStats } from '../../lib/systemApi';
import { PageHeader } from '../../components/shell/PageHeader';
import { Chart } from '../../components/Chart';

const { Text } = Typography;

/**
 * 租户状态统计 —— 后端返回的形状（`web/lib/systemApi.ts` 里那份类型没有
 * `expired_total`，这里本地扩一个字段，不改别人管的文件）。
 *
 * ⚠️ **三个数互不重叠**（2026-10-27 统一口径）：
 *   启用中 = status='active' 且没过期
 *   已禁用 = status='disabled'
 *   已到期 = status='active' 且过期
 *   → 三者相加 = 租户总数
 *   `expired_total` = 全部过期租户（含已禁用的）→ 用来说明重叠部分
 */
interface SystemTenantStatsExt {
  total: number;
  active: number;
  disabled: number;
  expired: number;
  expired_total?: number;
  plans: Array<{ plan: string; count: number }>;
}

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
        itemStyle: { color: token.colorPrimary },
      },
      {
        name: '花费',
        type: 'bar',
        yAxisIndex: 1,
        data: (stats?.trend ?? []).map((t) => t.cost),
        itemStyle: { color: token.colorSuccess },
      },
    ],
  };

  /**
   * ⚠️ **单位是 token，不是钱**（2026-10-27 修）——
   *    后端比的是 `monthly_token_budget`（月度 token 预算），
   *    以前列名叫「本月已用 / 预算 / 超出」，旁边的 KPI 卡又写「今日成本 $X」，
   *    运营会把 1200000 读成 $1.2M。列名必须写清 token。
   */
  const overBudgetColumns: TableColumnsType<SystemStats['over_budget'][number]> = [
    { title: '租户号', dataIndex: 'code', key: 'code', width: 140, ellipsis: true },
    { title: '名称', dataIndex: 'name', key: 'name', ellipsis: true },
    {
      title: '本月 token 用量',
      dataIndex: 'used',
      key: 'used',
      width: 150,
      render: (v: number) => v.toLocaleString('zh-CN'),
    },
    {
      title: 'token 预算',
      dataIndex: 'limit',
      key: 'limit',
      width: 150,
      render: (v: number) => v.toLocaleString('zh-CN'),
    },
    {
      // ⚠️ 这一列是**用量占比**（used / limit），不是「超出率」——
      //    后端已经过滤掉 used <= limit 的租户，所以这里恒 > 100%
      title: '用量占比',
      key: 'ratio',
      width: 110,
      render: (_: unknown, row) => (
        <Text strong style={{ color: token.colorError }}>
          {Math.round((row.used / row.limit) * 100)}%
        </Text>
      ),
    },
  ];

  const tenants = (stats?.tenants ?? null) as SystemTenantStatsExt | null;
  const expiredTotal = tenants?.expired_total ?? tenants?.expired ?? 0;
  const expiredAlsoDisabled = Math.max(0, expiredTotal - (tenants?.expired ?? 0));

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
                : `启用中 ${tenants?.active ?? 0} · 已禁用 ${tenants?.disabled ?? 0} · 已到期 ${tenants?.expired ?? 0}`
            }
            hint={
              stats === null
                ? undefined
                : `三个数互不重叠，合计 = 总租户数${
                    expiredAlsoDisabled > 0
                      ? `（另有 ${expiredAlsoDisabled} 个已禁用的租户也已到期）`
                      : ''
                  }`
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
          <Chart option={trendOption} height={280} />
        )}
      </Card>

      <Card
        title="本月 token 超预算的租户"
        style={{ marginBottom: 16 }}
        extra={
          <Text type="secondary" style={{ fontSize: 12 }}>
            口径：月度 token 预算（不是金额）· 只看显式配过预算的租户
          </Text>
        }
      >
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
            <ShopOutlined style={{ color: token.colorPrimary, fontSize: 18 }} />
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
  hint,
}: {
  label: string;
  value: string;
  extra?: string | undefined;
  hint?: string | undefined;
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
      {hint !== undefined && (
        <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
          {hint}
        </Text>
      )}
    </Card>
  );
}
