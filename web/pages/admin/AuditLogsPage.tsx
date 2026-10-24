import type { ReactElement } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, DatePicker, Select, Space, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { PageHeader } from '../../components/shell/PageHeader';
import { adminApi, fetchAuditActions, fetchAuditLogs, type AuditItem } from '../../lib/adminApi';

const { Text, Paragraph } = Typography;

const PAGE_SIZE = 20;

/**
 * 操作类型的中文标签
 *
 * 只是**展示**用的映射 —— 筛选下拉框里的选项来自后端给的真实清单
 * （GET /audit/actions），因为 action 是自由字符串，前端写死一份清单迟早漏项。
 * 这里认不出来的 action 原样显示（后端加新类型时不用改前端就能看）。
 */
const ACTION_LABEL: Record<string, string> = {
  API_KEY_CREATED: '创建 API Key',
  API_KEY_REVOKED: '吊销 API Key',
  CONTENT_MODERATION_BLOCKED: '内容审核拦截',
  COST_BUDGET_EXCEEDED: '成本超预算',
  DOCUMENT_UPLOAD: '上传文档',
  DOCUMENT_DELETE: '删除文档',
  DOCUMENT_INDEX_FAILED: '文档索引失败',
  EVALUATION_DATASET_CREATED: '创建评测集',
  EVALUATION_DATASET_DELETED: '删除评测集',
  EVALUATION_RUN_STARTED: '触发评测跑批',
  EVALUATION_SCORE_DROPPED: '评测分数下跌',
  PROMPT_INJECTION_BLOCKED: '提示词注入拦截',
  PROMPT_PUBLISH: '发布提示词',
  PROMPT_ROLLBACK: '回滚提示词',
  PROMPT_VERSION_CREATE: '新建提示词版本',
  PROMPT_VERSION_DELETE: '删除提示词版本',
  RATE_LIMIT_EXCEEDED: '触发限流',
  TENANT_MODEL_CREATE: '新建模型配置',
  TENANT_MODEL_UPDATE: '修改模型配置',
  TENANT_MODEL_ACTIVATE: '启用模型',
  TENANT_MODEL_DELETE: '删除模型',
  TENANT_SETTINGS_CHANGE: '修改租户设置',
  USER_CREATED: '创建用户',
  USER_UPDATED: '修改用户',
  USER_DELETED: '删除用户',
  USER_MEMORY_CREATED: '新建记忆',
  USER_MEMORY_UPDATED: '修改记忆',
  USER_MEMORY_ARCHIVED: '归档记忆',
  USER_MEMORY_RESTORED: '恢复记忆',
  USER_MEMORY_CLEARED: '清空记忆',
  USER_MEMORY_PURGED: '物理删除记忆',
  USER_MEMORY_EXTRACTED: '抽取记忆',
  USER_MEMORY_TOGGLED: '开关自动记忆',
};

/** 拦截类操作标红 —— 运维最关心的就是这几类 */
const ALERT_ACTIONS = new Set([
  'PROMPT_INJECTION_BLOCKED',
  'CONTENT_MODERATION_BLOCKED',
  'RATE_LIMIT_EXCEEDED',
  'COST_BUDGET_EXCEEDED',
  'DOCUMENT_INDEX_FAILED',
]);

interface TenantUser {
  id: string;
  email: string;
  role: string;
}

function actionLabel(action: string): string {
  return ACTION_LABEL[action] ?? action;
}

/**
 * /admin/audit —— 租户后台的「审计日志」
 *
 * 数据来自 GET /audit（src/gateway/admin/audit-routes.ts）。
 * 一行 = 一次关键操作（建用户 / 改配置 / 传文档 / 动记忆 …）。
 *
 * ⚠️ **只看得到本租户的日志**：后端查询强制带 tenant_id 过滤，
 * 系统级日志（平台方改租户启停 / 到期时间那类，tenant_id 为空）
 * 租户 admin 是看不到的 —— 这是设计如此，不是 bug。
 *
 * UI 详见 docs/04-c-ui-后台管理页面.md §5.10
 */
export function AdminAuditLogsPage(): ReactElement {
  const [rows, setRows] = useState<AuditItem[] | null>(null);
  const [pagination, setPagination] = useState<{ total: number } | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // 筛选项
  const [actions, setActions] = useState<string[]>([]);
  const [users, setUsers] = useState<TenantUser[]>([]);
  const [actionFilter, setActionFilter] = useState<string | undefined>(undefined);
  const [userFilter, setUserFilter] = useState<string | undefined>(undefined);
  const [range, setRange] = useState<[Dayjs, Dayjs] | null>(null);

  // 分页
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);

  const load = async (): Promise<void> => {
    setLoading(true);
    setErrMsg(null);
    try {
      const res = await fetchAuditLogs({
        page,
        page_size: pageSize,
        action: actionFilter,
        user_id: userFilter,
        from: range?.[0].toISOString(),
        to: range?.[1].toISOString(),
      });
      setRows(res.logs);
      setPagination({ total: res.pagination.total });
    } catch (e: unknown) {
      const status = (e as { response?: { status?: number } }).response?.status;
      setRows(null);
      setErrMsg(status === 401 ? '鉴权失败（需 admin 角色）' : '加载失败');
    } finally {
      setLoading(false);
    }
  };

  // 筛选项（操作类型 + 可选用户）只依赖租户，页面挂载时拉一次
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [acts, usersRes] = await Promise.all([
          fetchAuditActions(),
          adminApi.get<{ users: TenantUser[] }>('/users'),
        ]);
        if (!cancelled) {
          setActions(acts);
          setUsers(usersRes.data.users);
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
  }, [page, pageSize, actionFilter, userFilter, range]);

  const actionOptions = useMemo(
    () =>
      actions.map((a) => ({
        value: a,
        label: `${actionLabel(a)}（${a}）`,
      })),
    [actions],
  );

  const userOptions = useMemo(
    () =>
      users.map((u) => ({
        value: u.id,
        label: u.email,
      })),
    [users],
  );

  const columns: TableColumnsType<AuditItem> = [
    {
      title: '时间',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 180,
      render: (t: string) => new Date(t).toLocaleString(),
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
          <span style={{ color: 'rgba(0,0,0,0.45)' }}>—</span>
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
        ip === null ? <span style={{ color: 'rgba(0,0,0,0.45)' }}>—</span> : ip,
    },
  ];

  return (
    <div>
      <PageHeader
        title="审计日志"
        subtitle="本租户的关键操作留痕：谁、什么时候、改了什么。"
        breadcrumb={[{ title: '首页' }, { title: '审计日志' }]}
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
          <Select
            value={userFilter}
            onChange={(v) => {
              setUserFilter(v);
              setPage(1);
            }}
            allowClear
            placeholder="操作用户"
            style={{ width: 220 }}
            options={userOptions}
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
                  background: 'rgba(0,0,0,0.03)',
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
          这里只显示本租户的操作记录。平台方对租户本身做的改动（启停 / 到期时间）属于系统级日志，
          不在本页范围内。
        </Paragraph>
      </Card>
    </div>
  );
}
