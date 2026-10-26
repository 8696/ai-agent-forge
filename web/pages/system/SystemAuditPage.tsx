import type { ReactElement } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, DatePicker, Select, Space, Table, Tag, Typography, theme } from 'antd';
import type { TableColumnsType } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { PageHeader } from '../../components/shell/PageHeader';
import {
  systemApi,
  fetchSystemAuditActions,
  fetchSystemAuditLogs,
  type SystemAuditItem,
} from '../../lib/systemApi';
import { ACTION_LABEL, ALERT_ACTIONS, actionLabel } from '../../lib/auditActions';

const { Text, Paragraph } = Typography;

const PAGE_SIZE = 20;


interface TenantRow {
  id: string;
  code: string;
  name: string;
}

/**
 * /system/audit —— 平台方的「审计日志」（**跨租户**）
 *
 * 数据来自 GET /api/v1/system/audit（src/gateway/system/audit-routes.ts）。
 *
 * ⚠️ **跟租户后台的 /admin/audit 是两个视角**：
 *   - 租户 admin：只看得到本租户的，系统级日志（tenant_id 为空）看不到
 *   - 平台方（本页）：**全部租户 + 系统级日志**都看得到
 *
 * UI 详见 docs/04-d-ui-系统级与公共组件.md §6.1
 */
export function SystemAuditPage(): ReactElement {
  // 颜色走 antd token —— 写死浅色的话，深色模式下几乎看不见
  const { token } = theme.useToken();
  const [rows, setRows] = useState<SystemAuditItem[] | null>(null);
  const [pagination, setPagination] = useState<{ total: number } | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // 筛选项
  const [actions, setActions] = useState<string[]>([]);
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [actionFilter, setActionFilter] = useState<string | undefined>(undefined);
  const [tenantFilter, setTenantFilter] = useState<string | undefined>(undefined);
  const [range, setRange] = useState<[Dayjs, Dayjs] | null>(null);

  // 分页
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);

  const load = async (): Promise<void> => {
    setLoading(true);
    setErrMsg(null);
    try {
      const res = await fetchSystemAuditLogs({
        page,
        page_size: pageSize,
        action: actionFilter,
        tenant_id: tenantFilter,
        from: range?.[0].toISOString(),
        to: range?.[1].toISOString(),
      });
      setRows(res.logs);
      setPagination({ total: res.pagination.total });
    } catch (e: unknown) {
      const status = (e as { response?: { status?: number } }).response?.status;
      setRows(null);
      setErrMsg(status === 401 ? '鉴权失败（需 system 角色）' : '加载失败');
    } finally {
      setLoading(false);
    }
  };

  // 筛选项（操作类型 + 租户）只依赖数据本身，页面挂载时拉一次
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [acts, tenantsRes] = await Promise.all([
          fetchSystemAuditActions(),
          systemApi.get<{ tenants: TenantRow[] }>('/tenants'),
        ]);
        if (!cancelled) {
          setActions(acts);
          setTenants(tenantsRes.data.tenants);
        }
      } catch {
        // 筛选项拉不到就不显示筛选下拉框，列表本身照常拉
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize, actionFilter, tenantFilter, range]);

  const actionOptions = useMemo(
    () => actions.map((a) => ({ value: a, label: `${actionLabel(a)}（${a}）` })),
    [actions],
  );

  const tenantOptions = useMemo(
    () =>
      tenants.map((t) => ({
        value: t.id,
        label: `${t.name}（${t.code}）`,
      })),
    [tenants],
  );

  /** 租户 id → 租户号/名字（系统级日志没有租户，显示「系统」） */
  const tenantLabel = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of tenants) {
      map.set(t.id, `${t.name}（${t.code}）`);
    }
    return map;
  }, [tenants]);

  const columns: TableColumnsType<SystemAuditItem> = [
    {
      title: '时间',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 180,
      render: (t: string) => new Date(t).toLocaleString(),
    },
    {
      title: '租户',
      dataIndex: 'tenant_id',
      key: 'tenant_id',
      width: 200,
      ellipsis: true,
      render: (tid: string | null) =>
        tid === null ? (
          <Tag color="blue">系统级</Tag>
        ) : (
          <span>{tenantLabel.get(tid) ?? tid}</span>
        ),
    },
    {
      title: '用户',
      dataIndex: 'user_email',
      key: 'user_email',
      width: 200,
      ellipsis: true,
      render: (email: string | null, row) =>
        email !== null ? (
          email
        ) : (
          <Text type="secondary">{row.user_id === null ? '系统' : `${row.user_id}（已删除）`}</Text>
        ),
    },
    {
      title: '操作',
      dataIndex: 'action',
      key: 'action',
      width: 220,
      ellipsis: true,
      render: (action: string) => (
        <Space size={6}>
          <Tag color={ALERT_ACTIONS.has(action) ? 'red' : 'default'}>{actionLabel(action)}</Tag>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {action}
          </Text>
        </Space>
      ),
    },
    {
      title: '资源',
      dataIndex: 'resource_type',
      key: 'resource_type',
      width: 220,
      ellipsis: true,
      render: (rt: string | null, row) =>
        rt === null ? (
          <span style={{ color: token.colorTextTertiary }}>—</span>
        ) : (
          <Space size={6}>
            <span>{rt}</span>
            {row.resource_id !== null && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {row.resource_id}
              </Text>
            )}
          </Space>
        ),
    },
    {
      title: 'IP',
      dataIndex: 'ip',
      key: 'ip',
      width: 150,
      render: (ip: string | null) =>
        ip === null ? <span style={{ color: token.colorTextTertiary }}>—</span> : ip,
    },
  ];

  return (
    <div>
      <PageHeader
        title="审计日志"
        subtitle="平台方视角：全部租户 + 系统级操作留痕。"
        breadcrumb={[{ title: '总览' }, { title: '审计日志' }]}
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
            value={tenantFilter}
            onChange={(v) => {
              setTenantFilter(v);
              setPage(1);
            }}
            allowClear
            placeholder="全部租户"
            style={{ width: 260 }}
            options={tenantOptions}
            showSearch
            optionFilterProp="label"
          />
          <Select
            value={actionFilter}
            onChange={(v) => {
              setActionFilter(v);
              setPage(1);
            }}
            allowClear
            placeholder="操作类型"
            style={{ width: 260 }}
            options={actionOptions}
            showSearch
            optionFilterProp="label"
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
          expandable={{
            rowExpandable: (row) => row.details !== null && row.details !== undefined,
            expandedRowRender: (row) => (
              <pre
                style={{
                  margin: 0,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  fontSize: 12,
                  background: token.colorFillQuaternary,
                  padding: 12,
                  borderRadius: 6,
                }}
              >
                {JSON.stringify(row.details, null, 2)}
              </pre>
            ),
          }}
          pagination={{
            current: page,
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
          locale={{
            emptyText:
              rows === null
                ? '加载中…'
                : '没有匹配的审计记录（换个筛选条件，或先去别的页面做点操作）',
          }}
        />

        <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0, fontSize: 12 }}>
          这里能看到<strong>全部租户</strong>的操作记录，包括「系统级」那类
          —— 平台方自己改租户启停 / 到期时间的动作没有租户归属，标成「系统级」。
          租户后台的审计页只看得到本租户的，两边是不同视角。
        </Paragraph>
      </Card>
    </div>
  );
}
