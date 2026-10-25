import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { Alert, Button, Card, Col, Empty, Row, Space, Tag, Typography, theme } from 'antd';
import { ReloadOutlined, RightOutlined, TeamOutlined } from '@ant-design/icons';
import { Link, useNavigate } from 'react-router-dom';
import { getCurrentUser } from '../../lib/auth';
import { fetchAlerts, type AdminAlert } from '../../lib/adminConfig';
import { fetchSummary, type ObservabilitySummary } from '../../lib/adminObservability';
import { PageHeader } from '../../components/shell/PageHeader';
import { Chart } from '../../components/Chart';

const { Text } = Typography;

/**
 * 告警 → 该去哪儿看。
 * 每条告警对应一个「能直接动手」的落点，点进去就能定位问题，
 * 而不是只给一句「出问题了」。
 */
const ALERT_TARGET: Record<string, { to: string; label: string }> = {
  error_rate_high: { to: '/admin/observability/traces?status=error', label: '看失败的 trace' },
  p95_latency_high: { to: '/admin/observability/traces', label: '看 trace 列表' },
  single_conversation_cost_high: { to: '/admin/observability/cost', label: '看成本分析' },
  cost_budget_exceeded: { to: '/admin/settings', label: '看租户设置' },
  cost_budget_near_limit: { to: '/admin/settings', label: '看租户设置' },
  evaluation_score_dropped: { to: '/admin/evaluation/runs', label: '看评测结果' },
  rate_limit_recent: { to: '/admin/observability/traces', label: '看 trace 列表' },
  security_blocks_recent: { to: '/admin/observability/traces', label: '看 trace 列表' },
};

/**
 * /admin —— 租户后台 Dashboard（D2 · docs/04-c-ui-后台管理页面.md §5.1）
 *
 * 4 张指标卡（今日对话数 / p95 延迟 / 今日成本 / 错误率）
 * + 2 张 7 天趋势图（对话量 / 成本）
 * + 异常告警列表（点进去跳到能定位问题的页面）
 *
 * 数据来自：
 *   - GET /observability/summary（指标 + 趋势）
 *   - GET /config/alerts（告警，与后台顶栏那条同源）
 */
export function AdminHomePage(): ReactElement {
  const user = getCurrentUser();
  const navigate = useNavigate();
  const { token } = theme.useToken();
  const [summary, setSummary] = useState<ObservabilitySummary | null>(null);
  const [alerts, setAlerts] = useState<AdminAlert[] | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async (): Promise<void> => {
    setLoading(true);
    setErrMsg(null);
    try {
      // 两个接口独立失败不互相连坐：指标挂了不该把告警也吞掉
      const [s, a] = await Promise.allSettled([fetchSummary(), fetchAlerts()]);
      setSummary(s.status === 'fulfilled' ? s.value : null);
      setAlerts(a.status === 'fulfilled' ? a.value : null);
      if (s.status === 'rejected' && a.status === 'rejected') {
        setErrMsg('加载后台概览失败');
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const trend = summary?.trend ?? [];

  const conversationOption = {
    tooltip: { trigger: 'axis' },
    grid: { left: 50, right: 20, top: 30, bottom: 40 },
    xAxis: { type: 'category', data: trend.map((t) => t.date) },
    yAxis: { type: 'value', name: '对话数' },
    series: [
      {
        name: '对话数',
        type: 'line',
        smooth: true,
        data: trend.map((t) => t.conversations),
        itemStyle: { color: '#1677ff' },
        areaStyle: { color: 'rgba(22,119,255,0.12)' },
      },
    ],
  };

  const costOption = {
    tooltip: { trigger: 'axis' },
    grid: { left: 60, right: 20, top: 30, bottom: 40 },
    xAxis: { type: 'category', data: trend.map((t) => t.date) },
    yAxis: { type: 'value', name: '花费 (USD)', axisLabel: { formatter: (v: number) => `$${v}` } },
    series: [
      {
        name: '花费',
        type: 'line',
        smooth: true,
        data: trend.map((t) => t.cost),
        itemStyle: { color: '#52c41a' },
        areaStyle: { color: 'rgba(82,196,26,0.12)' },
      },
    ],
  };

  return (
    <div>
      <PageHeader
        title="租户后台"
        subtitle={
          <>
            欢迎，<Text strong>{user?.email ?? user?.sub}</Text> —— 今天的健康度长这样。
          </>
        }
        extra={
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
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
            label="今日对话数"
            value={summary === null ? '—' : summary.today.conversations.toLocaleString('zh-CN')}
            extra={
              summary === null
                ? undefined
                : `平均延迟 ${summary.today.avg_latency_ms.toLocaleString('zh-CN')} ms`
            }
          />
        </Col>
        <Col xs={12} sm={12} lg={6}>
          <StatCard
            label="p95 延迟"
            value={summary === null ? '—' : `${summary.today.p95_latency_ms.toLocaleString('zh-CN')} ms`}
            extra="从用户发消息到看到首个字"
          />
        </Col>
        <Col xs={12} sm={12} lg={6}>
          <StatCard
            label="今日成本"
            value={summary === null ? '—' : `$${summary.today.cost.toFixed(4)}`}
            extra={
              summary === null
                ? undefined
                : `${summary.today.total_tokens.toLocaleString('zh-CN')} token`
            }
          />
        </Col>
        <Col xs={12} sm={12} lg={6}>
          <StatCard
            label="错误率"
            value={summary === null ? '—' : `${(summary.today.error_rate * 100).toFixed(1)}%`}
            extra={
              summary === null ? undefined : `${summary.today.errors} 次失败 / 共 ${summary.today.conversations} 次`
            }
            danger={summary !== null && summary.today.error_rate > 0.05}
          />
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} lg={12}>
          <Card title="7 天对话量">
            {trend.length === 0 ? (
              <Empty description="最近 7 天还没有对话记录" />
            ) : (
              <Chart option={conversationOption} height={260} />
            )}
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="7 天成本">
            {trend.length === 0 ? (
              <Empty description="最近 7 天还没有 LLM 调用" />
            ) : (
              <Chart option={costOption} height={260} />
            )}
          </Card>
        </Col>
      </Row>

      <Card title="异常告警" style={{ marginBottom: 16 }}>
        {alerts === null ? (
          <Empty description="加载中…" />
        ) : alerts.length === 0 ? (
          <Empty description="今天没有异常" />
        ) : (
          <div>
            {alerts.map((a, idx) => {
              const target = ALERT_TARGET[a.id];
              return (
                <div
                  key={a.id}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 12,
                    padding: '12px 0',
                    borderTop: idx === 0 ? 'none' : `1px solid ${token.colorBorderSecondary}`,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Space size={8}>
                      <Tag
                        color={a.level === 'error' ? 'error' : 'warning'}
                        style={{ fontWeight: 500 }}
                      >
                        {a.level === 'error' ? '严重' : '警告'}
                      </Tag>
                      <Text strong>{a.title}</Text>
                    </Space>
                    <div style={{ marginTop: 4 }}>
                      <Text type="secondary" style={{ fontSize: 13 }}>
                        {a.detail}
                      </Text>
                    </div>
                  </div>
                  {target !== undefined && (
                    <Button type="link" size="small" onClick={() => navigate(target.to)}>
                      {target.label}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Link to="/admin/users" style={{ display: 'block', maxWidth: 420 }}>
        <Card hoverable styles={{ body: { padding: '18px 20px' } }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <TeamOutlined style={{ color: '#13c2c2', fontSize: 18 }} />
            <Text strong style={{ fontSize: 15, flex: 1 }}>
              用户管理
            </Text>
            <RightOutlined style={{ color: token.colorTextQuaternary }} />
          </div>
          <Text type="secondary">管理本租户的后台管理员和前台用户。</Text>
        </Card>
      </Link>
    </div>
  );
}

function StatCard({
  label,
  value,
  extra,
  danger = false,
}: {
  label: string;
  value: string;
  extra?: string | undefined;
  danger?: boolean;
}): ReactElement {
  return (
    <Card styles={{ body: { padding: '18px 20px' } }}>
      <Text type="secondary" style={{ fontSize: 12 }}>
        {label}
      </Text>
      <div
        style={{
          fontSize: 26,
          fontWeight: 600,
          lineHeight: 1.35,
          color: danger ? '#cf1322' : undefined,
        }}
      >
        {value}
      </div>
      {extra !== undefined && (
        <Text type="secondary" style={{ fontSize: 12 }}>
          {extra}
        </Text>
      )}
    </Card>
  );
}
