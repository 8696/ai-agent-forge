import type { ReactElement } from 'react';
import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Input,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import type { Dayjs } from 'dayjs';
import { ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { PageHeader } from '../../components/shell';
import {
  fetchToolCallLogs,
  fetchToolCallNames,
  toolLogErrorMessage,
  type ToolCallLogItem,
  type ToolCallStatus,
} from '../../lib/adminToolLogs';

/**
 * §5.12 工具调用记录 `/admin/tool-logs`（B3）—— 详见 docs/04-c-ui-后台管理页面.md
 *
 * **一行 = 一次工具调用**，带请求参数和响应参数。
 * 回答的是「AI 到底调没调这个工具、调了什么参数、返回了什么」——
 * 联调时最常问的问题。
 *
 * 状态：
 *  - `ok` 调用成功
 *  - `error` 工具抛错（已降级成 tool result 回灌，整轮对话没挂）
 *  - `timeout` 超过 5 秒被放弃
 *  - `awaiting_confirmation` 敏感工具被 HITL 闸门拦下，**没有真正执行**
 */

const { Text, Paragraph } = Typography;

const PAGE_SIZE = 20;

const STATUS_LABEL: Record<ToolCallStatus, string> = {
  ok: '调用成功',
  error: '调用失败',
  timeout: '超时',
  awaiting_confirmation: '待确认（未执行）',
};

const STATUS_COLOR: Record<ToolCallStatus, string> = {
  ok: 'green',
  error: 'red',
  timeout: 'orange',
  awaiting_confirmation: 'gold',
};

/** JSON 参数的展示：压成一行，展开看全文 */
function JsonCell({ value, empty }: { value: unknown; empty: string }): ReactElement {
  if (value === null || value === undefined) {
    return (
      <Text type="secondary" style={{ fontSize: 12 }}>
        {empty}
      </Text>
    );
  }
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === '') {
    return (
      <Text type="secondary" style={{ fontSize: 12 }}>
        {empty}
      </Text>
    );
  }
  return (
    <Paragraph
      copyable={{ text }}
      style={{ fontSize: 12, marginBottom: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
      ellipsis={{ rows: 3, expandable: true, symbol: '展开全文' }}
    >
      {text}
    </Paragraph>
  );
}

export function ToolLogsPage(): ReactElement {
  const [rows, setRows] = useState<ToolCallLogItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // 筛选项
  const [names, setNames] = useState<string[]>([]);
  const [toolFilter, setToolFilter] = useState<string | undefined>(undefined);
  const [statusFilter, setStatusFilter] = useState<ToolCallStatus | undefined>(undefined);
  const [range, setRange] = useState<[Dayjs, Dayjs] | null>(null);
  const [keywordInput, setKeywordInput] = useState('');
  const [keyword, setKeyword] = useState<string | undefined>(undefined);

  // 分页
  const [page, setPage] = useState(1);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setErrMsg(null);
    try {
      const res = await fetchToolCallLogs({
        page,
        page_size: PAGE_SIZE,
        tool_name: toolFilter,
        status: statusFilter,
        from: range?.[0].toISOString(),
        to: range?.[1].toISOString(),
        keyword,
      });
      setRows(res.logs);
      setTotal(res.pagination.total);
    } catch (e: unknown) {
      setRows(null);
      setErrMsg(toolLogErrorMessage(e, '加载工具调用记录失败'));
    } finally {
      setLoading(false);
    }
  }, [page, toolFilter, statusFilter, range, keyword]);

  // 工具名下拉框：只依赖租户，页面挂载时拉一次
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await fetchToolCallNames();
        if (!cancelled) {
          setNames(list);
        }
      } catch {
        // 拉不到就不显示下拉框，列表本身照常拉
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: TableColumnsType<ToolCallLogItem> = [
    {
      title: '时间',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 170,
      render: (t: string) => new Date(t).toLocaleString(),
    },
    {
      title: '工具',
      dataIndex: 'tool_name',
      key: 'tool_name',
      width: 180,
      ellipsis: true,
      render: (v: string, row) => (
        <Space size={6}>
          <Text strong>{v}</Text>
          {row.builtin !== null && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {row.builtin}
            </Text>
          )}
        </Space>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 130,
      render: (s: ToolCallStatus) => <Tag color={STATUS_COLOR[s]}>{STATUS_LABEL[s]}</Tag>,
    },
    {
      title: '耗时',
      dataIndex: 'duration_ms',
      key: 'duration_ms',
      width: 90,
      render: (ms: number) => <Text type="secondary">{ms} ms</Text>,
    },
    {
      title: '请求参数',
      dataIndex: 'args',
      key: 'args',
      width: 320,
      render: (v: unknown) => <JsonCell value={v} empty="（无入参）" />,
    },
    {
      title: '响应参数',
      dataIndex: 'output',
      key: 'output',
      width: 320,
      render: (v: unknown, row) =>
        row.status === 'awaiting_confirmation' ? (
          <Text type="secondary" style={{ fontSize: 12 }}>
            （被 HITL 闸门拦下，没有执行）
          </Text>
        ) : (
          <JsonCell value={v} empty="（无返回）" />
        ),
    },
    {
      title: '错误',
      dataIndex: 'error',
      key: 'error',
      width: 200,
      ellipsis: true,
      render: (e: string | null) =>
        e === null ? (
          <Text type="secondary">—</Text>
        ) : (
          <Text type="danger" style={{ fontSize: 12 }}>
            {e}
          </Text>
        ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="工具调用记录"
        subtitle="AI 每调一次工具就记一行：什么时候调的、给了什么参数、返回了什么。"
        breadcrumb={[{ title: '首页' }, { title: '工具调用记录' }]}
        extra={
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>
            刷新
          </Button>
        }
      />

      {errMsg !== null && (
        <Alert type="error" showIcon title={errMsg} style={{ marginBottom: 16 }} />
      )}

      <Card styles={{ body: { padding: 16 } }}>
        <Space wrap size={12} style={{ marginBottom: 12 }}>
          <Select
            value={toolFilter}
            onChange={(v) => {
              setToolFilter(v);
              setPage(1);
            }}
            allowClear
            placeholder="工具"
            style={{ width: 220 }}
            options={names.map((n) => ({ value: n, label: n }))}
            showSearch
            optionFilterProp="label"
          />
          <Select
            value={statusFilter}
            onChange={(v) => {
              setStatusFilter(v);
              setPage(1);
            }}
            allowClear
            placeholder="状态"
            style={{ width: 180 }}
            options={(Object.keys(STATUS_LABEL) as ToolCallStatus[]).map((s) => ({
              value: s,
              label: STATUS_LABEL[s],
            }))}
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
          <Input.Search
            value={keywordInput}
            onChange={(e) => setKeywordInput(e.target.value)}
            onSearch={(v) => {
              setKeyword(v.trim() === '' ? undefined : v.trim());
              setPage(1);
            }}
            placeholder="搜入参 / 返回值"
            style={{ width: 240 }}
            enterButton={<SearchOutlined />}
            allowClear
          />
        </Space>

        <Table<ToolCallLogItem>
          rowKey="id"
          size="small"
          loading={loading}
          columns={columns}
          dataSource={rows ?? []}
          scroll={{ x: 1400 }}
          locale={{
            emptyText:
              rows === null ? '加载中…' : '还没有工具调用记录（AI 还没调过工具，或者工具没启用）',
          }}
          pagination={{
            current: page,
            pageSize: PAGE_SIZE,
            total,
            showSizeChanger: false,
            showTotal: (t) => `共 ${t} 次调用`,
            onChange: (p) => setPage(p),
          }}
        />
      </Card>
    </div>
  );
}
