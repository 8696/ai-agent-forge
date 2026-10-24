import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import dayjs, { type Dayjs } from 'dayjs';
import { PageHeader } from '../../components/shell/PageHeader';
import {
  fetchTraces,
  observabilityErrorMessage,
  type Pagination,
  type TraceItem,
  type TraceStatus,
} from '../../lib/adminObservability';

const { Text } = Typography;

/**
 * /admin/observability/traces —— Trace 列表（D2）
 *
 * 数据来自 GET /observability/traces（src/gateway/admin/observability-routes.ts）。
 * 一行 = 一次用户视角的对话；点进去看它的时间线（哪一步慢、哪一步失败）。
 *
 * UI 详见 docs/04-c-ui-后台管理页面.md §5.7.1
 */
export function ObservabilityTraceListPage(): ReactElement {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [rows, setRows] = useState<TraceItem[] | null>(null);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // 状态筛选同步到 URL：Dashboard 的「错误率超标」告警点进来就是 ?status=error，
  // 链接也能直接分享给别人。
  const urlStatus = searchParams.get('status');
  const [status, setStatus] = useState<TraceStatus | 'all'>(
    urlStatus === 'error' || urlStatus === 'success' ? urlStatus : 'all',
  );
  const [range, setRange] = useState<[Dayjs, Dayjs] | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const onStatusChange = (v: TraceStatus | 'all'): void => {
    setStatus(v);
    setPage(1);
    const next = new URLSearchParams(searchParams);
    if (v === 'all') {
      next.delete('status');
    } else {
      next.set('status', v);
    }
    setSearchParams(next, { replace: true });
  };

  const load = async (): Promise<void> => {
    setLoading(true);
    setErrMsg(null);
    try {
      const res = await fetchTraces({
        page,
        page_size: pageSize,
        status: status === 'all' ? undefined : status,
        from: range?.[0].toISOString(),
        to: range?.[1].toISOString(),
      });
      setRows(res.traces);
      setPagination(res.pagination);
    } catch (err: unknown) {
      setRows(null);
      setErrMsg(observabilityErrorMessage(err, '加载 trace 列表失败'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize, status, range]);

  const columns: TableColumnsType<TraceItem> = [
    {
      title: '时间',
      dataIndex: 'started_at',
      key: 'started_at',
      width: 180,
      render: (t: string) => new Date(t).toLocaleString(),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 90,
      render: (s: TraceStatus) => (
        <Tag color={s === 'success' ? 'green' : 'red'}>{s === 'success' ? '成功' : '失败'}</Tag>
      ),
    },
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      width: 160,
      render: (n: string, row) => (
        <Space size={6}>
          <span>{n}</span>
          {row.channel !== null && <Tag>{row.channel}</Tag>}
        </Space>
      ),
    },
    {
      title: '模型',
      dataIndex: 'model',
      key: 'model',
      width: 160,
      ellipsis: true,
      render: (m: string | null) =>
        m === null ? <span style={{ color: 'rgba(0,0,0,0.45)' }}>—</span> : m,
    },
    {
      title: '耗时',
      dataIndex: 'duration_ms',
      key: 'duration_ms',
      width: 100,
      render: (d: number | null) =>
        d === null ? <span style={{ color: 'rgba(0,0,0,0.45)' }}>—</span> : `${d} ms`,
    },
    {
      title: 'Token',
      dataIndex: 'total_tokens',
      key: 'total_tokens',
      width: 100,
      render: (t: number) => t.toLocaleString('zh-CN'),
    },
    {
      title: '成本',
      dataIndex: 'cost',
      key: 'cost',
      width: 100,
      render: (c: number) => `$${c.toFixed(4)}`,
    },
    {
      title: '错误',
      dataIndex: 'error_message',
      key: 'error_message',
      ellipsis: true,
      render: (e: string | null) =>
        e === null ? <span style={{ color: 'rgba(0,0,0,0.45)' }}>—</span> : <Text type="danger">{e}</Text>,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Trace 列表"
        subtitle="每一次对话的调用链：跑了多久、用了多少 token、哪一步失败。"
        breadcrumb={[{ title: '首页' }, { title: '观测' }, { title: 'Trace 列表' }]}
        extra={
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>
            刷新
          </Button>
        }
      />

      {errMsg !== null && (
        <Alert type="error" showIcon message={errMsg} style={{ marginBottom: 16 }} />
      )}

      <Card styles={{ body: { padding: 16 } }}>
        <Space wrap size={12} style={{ marginBottom: 12 }}>
          <Select
            value={status}
            onChange={onStatusChange}
            style={{ width: 140 }}
            options={[
              { value: 'all', label: '全部状态' },
              { value: 'success', label: '成功' },
              { value: 'error', label: '失败' },
            ]}
          />
          <DatePicker.RangePicker
            value={range}
            onChange={(v) => {
              setRange(v as [Dayjs, Dayjs] | null);
              setPage(1);
            }}
            showTime
            format="YYYY-MM-DD HH:mm"
          />
        </Space>

        <Table
          rowKey="id"
          columns={columns}
          dataSource={rows ?? []}
          loading={rows === null || loading}
          tableLayout="fixed"
          onRow={(row) => ({
            onClick: () => {
              navigate(`/admin/observability/traces/${row.id}`);
            },
            style: { cursor: 'pointer' },
          })}
          pagination={{
            current: pagination?.page ?? page,
            pageSize,
            total: pagination?.total ?? 0,
            showSizeChanger: true,
            pageSizeOptions: [20, 50, 100],
            showTotal: (total) => `共 ${total} 条`,
            onChange: (p, ps) => {
              setPage(p);
              setPageSize(ps);
            },
          }}
          locale={{ emptyText: rows === null ? '加载中…' : '还没有 trace（先在前台聊几句）' }}
        />
      </Card>
    </div>
  );
}
