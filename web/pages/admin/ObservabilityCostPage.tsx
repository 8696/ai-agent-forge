import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { Alert, Button, Card, DatePicker, Empty, Select, Space, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import dayjs, { type Dayjs } from 'dayjs';
import { PageHeader } from '../../components/shell/PageHeader';
import {
  fetchCostAnalysis,
  observabilityErrorMessage,
  type CostAnalysis,
  type CostBucket,
  type CostGroupBy,
  type CostRange,
} from '../../lib/adminObservability';

const { Text } = Typography;

/**
 * /admin/observability/cost —— 成本分析（D2 + D3）
 *
 * 数据来自 GET /observability/cost。底层是 D3 的 `cost_logs` 表
 * （一行一次 LLM 调用），所以「按模型拆」拆得出来 —— trace 粒度太粗。
 *
 * UI 详见 docs/04-c-ui-后台管理页面.md §5.7.3
 */
export function ObservabilityCostPage(): ReactElement {
  const [range, setRange] = useState<CostRange>('week');
  const [groupBy, setGroupBy] = useState<CostGroupBy>('model');
  const [customRange, setCustomRange] = useState<[Dayjs, Dayjs] | null>(null);
  const [data, setData] = useState<CostAnalysis | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async (): Promise<void> => {
    setLoading(true);
    setErrMsg(null);
    try {
      setData(
        await fetchCostAnalysis({
          range,
          group_by: groupBy,
          from: range === 'custom' ? customRange?.[0].toISOString() : undefined,
          to: range === 'custom' ? customRange?.[1].toISOString() : undefined,
        }),
      );
    } catch (err: unknown) {
      setData(null);
      setErrMsg(observabilityErrorMessage(err, '加载成本分析失败'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, groupBy, customRange]);

  const columns: TableColumnsType<CostBucket> = [
    {
      title: '维度',
      dataIndex: 'label',
      key: 'label',
      ellipsis: true,
      render: (label: string, row) => (
        <Space size={6}>
          <span>{label}</span>
          {row.key !== label && (
            <Text type="secondary" style={{ fontSize: 11 }}>
              {row.key}
            </Text>
          )}
        </Space>
      ),
    },
    {
      title: '调用次数',
      dataIndex: 'calls',
      key: 'calls',
      width: 110,
      render: (v: number) => v.toLocaleString('zh-CN'),
    },
    {
      title: '输入 token',
      dataIndex: 'input_tokens',
      key: 'input_tokens',
      width: 130,
      render: (v: number) => v.toLocaleString('zh-CN'),
    },
    {
      title: '输出 token',
      dataIndex: 'output_tokens',
      key: 'output_tokens',
      width: 130,
      render: (v: number) => v.toLocaleString('zh-CN'),
    },
    {
      title: '花费',
      dataIndex: 'cost',
      key: 'cost',
      width: 120,
      render: (v: number) => `$${v.toFixed(6)}`,
    },
  ];

  const chartOption = {
    tooltip: { trigger: 'axis' },
    grid: { left: 60, right: 20, top: 30, bottom: 40 },
    xAxis: { type: 'category', data: (data?.series ?? []).map((s) => s.key) },
    yAxis: [
      { type: 'value', name: '花费 (USD)', axisLabel: { formatter: (v: number) => `$${v}` } },
      { type: 'value', name: '调用次数' },
    ],
    series: [
      {
        name: '花费',
        type: 'bar',
        data: (data?.series ?? []).map((s) => s.cost),
        itemStyle: { color: '#1677ff' },
      },
      {
        name: '调用次数',
        type: 'line',
        yAxisIndex: 1,
        data: (data?.series ?? []).map((s) => s.calls),
        itemStyle: { color: '#52c41a' },
      },
    ],
  };

  return (
    <div>
      <PageHeader
        title="成本分析"
        subtitle="钱花在哪了：按时间趋势看曲线，按模型 / 用户 / 渠道拆开看构成。"
        breadcrumb={[{ title: '首页' }, { title: '观测' }, { title: '成本分析' }]}
        extra={
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>
            刷新
          </Button>
        }
      />

      {errMsg !== null && (
        <Alert type="error" showIcon message={errMsg} style={{ marginBottom: 16 }} />
      )}

      <Card styles={{ body: { padding: 16 } }} style={{ marginBottom: 16 }}>
        <Space wrap size={12}>
          <Select
            value={range}
            onChange={setRange}
            style={{ width: 140 }}
            options={[
              { value: 'day', label: '今天' },
              { value: 'week', label: '最近 7 天' },
              { value: 'month', label: '本月' },
              { value: 'custom', label: '自定义' },
            ]}
          />
          {range === 'custom' && (
            <DatePicker.RangePicker
              value={customRange}
              onChange={(v) => setCustomRange(v as [Dayjs, Dayjs] | null)}
              showTime
              format="YYYY-MM-DD HH:mm"
            />
          )}
          <Select
            value={groupBy}
            onChange={setGroupBy}
            style={{ width: 160 }}
            options={[
              { value: 'model', label: '按模型拆' },
              { value: 'provider', label: '按 provider 拆' },
              { value: 'user', label: '按用户拆' },
              { value: 'channel', label: '按渠道拆' },
            ]}
          />
        </Space>
      </Card>

      {data !== null && (
        <>
          <Card style={{ marginBottom: 16 }}>
            <Space size={40} wrap>
              <Metric label="LLM 调用" value={data.totals.calls.toLocaleString('zh-CN')} />
              <Metric label="总 token" value={data.totals.total_tokens.toLocaleString('zh-CN')} />
              <Metric label="花费" value={`$${data.totals.cost.toFixed(4)}`} />
              <Metric label="时间范围" value={`${new Date(data.range.from).toLocaleDateString()} ~ ${new Date(data.range.to).toLocaleDateString()}`} small />
            </Space>
          </Card>

          <Card title="每日趋势" style={{ marginBottom: 16 }}>
            {data.series.length === 0 ? (
              <Empty description="这个时间范围内没有 LLM 调用" />
            ) : (
              <ReactECharts option={chartOption} style={{ height: 320 }} notMerge />
            )}
          </Card>

          <Card title="构成拆解">
            <Table
              rowKey="key"
              columns={columns}
              dataSource={data.breakdown}
              loading={loading}
              pagination={false}
              tableLayout="fixed"
              locale={{ emptyText: '这个时间范围内没有 LLM 调用' }}
            />
          </Card>
        </>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  small = false,
}: {
  label: string;
  value: string;
  small?: boolean;
}): ReactElement {
  return (
    <div>
      <Text type="secondary" style={{ fontSize: 12 }}>
        {label}
      </Text>
      <div
        style={{
          fontSize: small ? 14 : 22,
          fontWeight: small ? 500 : 600,
          lineHeight: 1.3,
        }}
      >
        {value}
      </div>
    </div>
  );
}
