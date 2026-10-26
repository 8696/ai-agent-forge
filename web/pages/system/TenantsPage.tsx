import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { systemApi } from '../../lib/systemApi';
import { PageHeader } from '../../components/shell/PageHeader';
import { EmptyState } from '../../components/shell/EmptyState';
import { TENANT_CODE_PATTERN, TENANT_CODE_HINT } from '@shared/validation/tenant-code';

interface TenantRow {
  id: string;
  code: string;
  name: string;
  plan: 'free' | 'pro' | 'enterprise';
  status: 'active' | 'disabled';
  expires_at: string | null;
  /** 已到期（时间过了）—— 跟 status='disabled' 是两回事 */
  expired: boolean;
  /** 该租户的用户总数 */
  user_count: number;
  created_at: string;
  admin: { id: string; email: string; must_change_password: boolean } | null;
}

/** 列表的筛选条件（04-d §6.1：搜索框 / 套餐筛选 / 状态筛选） */
interface TenantFilters {
  // ⚠️ 显式带 `| undefined` —— 清除筛选时会把字段设成 undefined
  //    （exactOptionalPropertyTypes 开着，不加这个编译不过）
  keyword?: string | undefined;
  plan?: TenantRow['plan'] | undefined;
  status?: 'active' | 'disabled' | 'expired' | undefined;
}

const STATUS_OPTIONS: Array<{ value: TenantFilters['status']; label: string }> = [
  { value: 'active', label: '启用中' },
  { value: 'disabled', label: '已禁用' },
  { value: 'expired', label: '已到期' },
];

const PLAN_OPTIONS: Array<{ value: TenantRow['plan']; label: string }> = [
  { value: 'free', label: 'Free' },
  { value: 'pro', label: 'Pro' },
  { value: 'enterprise', label: 'Enterprise' },
];

const PLAN_COLOR: Record<string, string> = {
  free: 'default',
  pro: 'blue',
  enterprise: 'gold',
};

const PLAN_LABEL: Record<string, string> = {
  free: 'Free',
  pro: 'Pro',
  enterprise: 'Enterprise',
};

function renderExpiresAt(iso: string | null): ReactElement {
  if (iso === null) {
    return <span>永不过期</span>;
  }
  const d = dayjs(iso);
  const text = d.format('MM-DD HH:mm');
  if (d.isBefore(dayjs())) {
    return <span style={{ color: '#cf1322' }}>{text} 已到期</span>;
  }
  return <span>{text}</span>;
}

/**
 * /system/tenants —— system 端租户列表
 * 详见 docs/12-e §F1 + §F2
 */
export function SystemTenantsPage(): ReactElement {
  const navigate = useNavigate();
  const [rows, setRows] = useState<TenantRow[] | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  /** 筛选条件 —— 搜索框 / 套餐 / 状态（04-d §6.1） */
  const [filters, setFilters] = useState<TenantFilters>({});

  // F2
  const [editingRow, setEditingRow] = useState<TenantRow | null>(null);
  const [expiresForm] = Form.useForm<{ expires_at: Dayjs | null }>();

  // A2 建租户
  const [creatingOpen, setCreatingOpen] = useState(false);
  interface CreateTenantForm {
    code: string;
    name: string;
    admin_email: string;
    admin_password: string;
    plan: TenantRow['plan'];
    expires_at: Dayjs | null;
  }
  const [createForm] = Form.useForm<CreateTenantForm>();

  const load = async (): Promise<void> => {
    setErrMsg(null);
    try {
      const res = await systemApi.get<{ tenants: TenantRow[] }>('/tenants', {
        // 空值不传 —— 后端按「没传 = 不筛」处理
        params: {
          ...(filters.keyword !== undefined && filters.keyword !== ''
            ? { keyword: filters.keyword }
            : {}),
          ...(filters.plan !== undefined ? { plan: filters.plan } : {}),
          ...(filters.status !== undefined ? { status: filters.status } : {}),
        },
      });
      setRows(res.data.tenants);
    } catch (e: unknown) {
      const status = (e as { response?: { status?: number } }).response?.status;
      setErrMsg(status === 401 ? '鉴权失败（需 system 角色）' : '加载失败');
    }
  };

  // 筛选条件变了就重新拉 —— 筛选在**服务端**做（租户多了以后前端筛不动）
  useEffect(() => {
    void load();
  }, [filters]);

  const toIsoOrNull = (v: Dayjs | null | undefined): string | null =>
    v === undefined || v === null ? null : v.toDate().toISOString();

  const onSubmitExpires = async (): Promise<void> => {
    if (editingRow === null) return;
    const v = await expiresForm.validateFields().catch(() => null);
    if (v === null) return;
    try {
      await systemApi.patch(`/tenants/${editingRow.id}/expires_at`, {
        expires_at: toIsoOrNull(v.expires_at),
      });
      message.success(editingRow.expires_at === null ? '已设置到期时间' : '已更新到期时间');
      setEditingRow(null);
      await load();
    } catch (e) {
      const status = (e as { response?: { status?: number } }).response?.status;
      message.error(status === 400 ? '请求格式不合法' : '保存到期时间失败');
    }
  };

  const onToggleStatus = async (row: TenantRow): Promise<void> => {
    const next = row.status === 'active' ? 'disabled' : 'active';
    try {
      await systemApi.patch(`/tenants/${row.id}/status`, { status: next });
      message.success(next === 'disabled' ? `已禁用租户 ${row.code}` : `已启用租户 ${row.code}`);
      await load();
    } catch (e) {
      const status = (e as { response?: { status?: number } }).response?.status;
      const data = (e as { response?: { data?: { message?: string } } }).response?.data;
      message.error(status === 400 ? (data?.message ?? '不能执行此操作') : '启停失败');
    }
  };

  const submitCreate = async (): Promise<void> => {
    const v = await createForm.validateFields().catch(() => null);
    if (v === null) return;
    try {
      const res = await systemApi.post<{ tenant: { code: string }; admin: { email: string } }>(
        '/tenants',
        {
          code: v.code,
          name: v.name,
          admin_email: v.admin_email,
          admin_password: v.admin_password,
          plan: v.plan,
          // ⚠️ DatePicker 给的是 Dayjs 对象，要转成 ISO 字符串再发
          expires_at: toIsoOrNull(v.expires_at),
        },
      );
      message.success(
        `租户 ${res.data.tenant.code} 已创建，初始 admin：${res.data.admin.email}（首次登录会强制改密）`,
      );
      setCreatingOpen(false);
      createForm.resetFields();
      await load();
    } catch (e) {
      const status = (e as { response?: { status?: number } }).response?.status;
      const data = (e as { response?: { data?: { message?: string } } }).response?.data;
      if (status === 400 && data?.message !== undefined) {
        message.error(data.message);
      } else if (status === 401) {
        message.error('鉴权失败（需 system 角色）');
      } else {
        message.error('创建租户失败');
      }
    }
  };

  const columns: TableColumnsType<TenantRow> = [
    {
      title: '租户号',
      dataIndex: 'code',
      key: 'code',
      width: 120,
      ellipsis: true,
      render: (code: string, row) => (
        <span
          onClick={() => navigate(`/system/tenants/${row.id}`)}
          style={{
            color: '#2f54eb',
            cursor: 'pointer',
            fontWeight: 500,
          }}
        >
          {code}
        </span>
      ),
    },
    { title: '名称', dataIndex: 'name', key: 'name', ellipsis: true },
    {
      title: '套餐',
      dataIndex: 'plan',
      key: 'plan',
      width: 88,
      render: (plan: string) => (
        <Tag color={PLAN_COLOR[plan] ?? 'default'} style={{ fontWeight: 500 }}>
          {PLAN_LABEL[plan] ?? plan}
        </Tag>
      ),
    },
    {
      title: '用户数',
      dataIndex: 'user_count',
      key: 'user_count',
      width: 80,
      render: (n: number) => <span>{n}</span>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 96,
      render: (s: TenantRow['status'], row: TenantRow) =>
        s === 'disabled' ? (
          <Tag color="error" style={{ fontWeight: 500 }}>
            已禁用
          </Tag>
        ) : row.expired ? (
          <Tag color="warning" style={{ fontWeight: 500 }}>
            已到期
          </Tag>
        ) : (
          <Tag color="success" style={{ fontWeight: 500 }}>
            启用
          </Tag>
        ),
    },
    {
      title: '到期时间',
      dataIndex: 'expires_at',
      key: 'expires_at',
      width: 156,
      ellipsis: true,
      render: (iso: TenantRow['expires_at']) => renderExpiresAt(iso),
    },
    {
      title: '初始 admin',
      dataIndex: 'admin',
      key: 'admin',
      ellipsis: true,
      render: (admin: TenantRow['admin']) =>
        admin === null ? (
          <Tag color="red">无</Tag>
        ) : (
          <Space orientation="vertical" size={0}>
            <span style={{ fontWeight: 500 }}>{admin.email}</span>
            {admin.must_change_password && (
              <Tag color="orange" style={{ marginInlineEnd: 0 }}>
                待改密
              </Tag>
            )}
          </Space>
        ),
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 156,
      ellipsis: true,
      render: (t: string) => new Date(t).toLocaleString(),
    },
    {
      title: '操作',
      key: 'actions',
      width: 132,
      render: (_: unknown, row) => (
        <Space size={0} onClick={(e) => e.stopPropagation()}>
          <Button
            type="link"
            size="small"
            onClick={() => {
              expiresForm.setFieldsValue({
                expires_at: row.expires_at === null ? null : dayjs(row.expires_at),
              });
              setEditingRow(row);
            }}
          >
            改到期
          </Button>
          <Popconfirm
            title={
              row.status === 'active'
                ? `确认禁用租户 ${row.code}？该租户下所有 admin / customer 账号将无法登录`
                : `确认启用租户 ${row.code}？`
            }
            okText="确认"
            cancelText="取消"
            okButtonProps={row.status === 'active' ? { danger: true } : { type: 'primary' }}
            onConfirm={() => void onToggleStatus(row)}
          >
            <Button
              type="link"
              size="small"
              danger={row.status === 'active'}
              disabled={row.code === 'system'}
            >
              {row.status === 'active' ? '禁用' : '启用'}
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="租户管理"
        subtitle="查看租户、修改到期时间、启用或禁用。"
        extra={
          <>
            <Button icon={<ReloadOutlined />} onClick={() => void load()}>
              刷新
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => setCreatingOpen(true)}
            >
              创建租户
            </Button>
          </>
        }
      />

      {errMsg !== null && (
        <Alert
          type="error"
          showIcon
          title={errMsg}
          style={{ marginBottom: 16 }}
        />
      )}

      {/* 筛选（04-d §6.1）：搜索框 / 套餐 / 状态 */}
      <Space style={{ marginBottom: 12 }} wrap>
        <Input.Search
          placeholder="搜索租户号 / 名称"
          allowClear
          style={{ width: 240 }}
          defaultValue={filters.keyword ?? ''}
          onSearch={(v: string) => setFilters((f) => ({ ...f, keyword: v }))}
        />
        <Select
          placeholder="套餐"
          allowClear
          style={{ width: 140 }}
          options={PLAN_OPTIONS}
          value={filters.plan}
          onChange={(v: TenantRow['plan'] | undefined) => setFilters((f) => ({ ...f, plan: v }))}
        />
        <Select
          placeholder="状态"
          allowClear
          style={{ width: 140 }}
          options={STATUS_OPTIONS}
          value={filters.status}
          onChange={(v: TenantFilters['status'] | undefined) => setFilters((f) => ({ ...f, status: v }))}
        />
      </Space>

      <Card styles={{ body: { padding: 16, overflow: 'hidden' } }}>
        <Table
          rowKey="id"
          columns={columns}
          dataSource={rows ?? []}
          loading={rows === null}
          pagination={false}
          tableLayout="fixed"
          locale={{ emptyText: rows === null ? '加载中…' : <EmptyState description="还没有租户" /> }}
          onRow={(row) => ({
            onClick: () => navigate(`/system/tenants/${row.id}`),
            style: { cursor: 'pointer' },
          })}
        />
      </Card>

      {/* F2 */}
      <Modal
        open={editingRow !== null}
        title={editingRow === null ? '' : `修改租户 ${editingRow.code} 的到期时间`}
        okText="保存"
        cancelText="取消"
        onOk={onSubmitExpires}
        onCancel={() => setEditingRow(null)}
        destroyOnHidden
      >
        <Form form={expiresForm} layout="vertical" preserve={false}>
          <Form.Item
            name="expires_at"
            label={
              <Space>
                <span>到期时间</span>
                <Button
                  size="small"
                  type="link"
                  onClick={() => expiresForm.setFieldValue('expires_at', null)}
                >
                  设为「永不过期」
                </Button>
              </Space>
            }
            extra="不填 = 永不过期（清空到期限制）"
          >
            <DatePicker showTime style={{ width: '100%' }} placeholder="留空表示永不过期" />
          </Form.Item>
        </Form>
      </Modal>

      {/* A2 */}
      <Modal
        open={creatingOpen}
        title="创建租户"
        okText="创建"
        cancelText="取消"
        width={520}
        onOk={submitCreate}
        onCancel={() => {
          setCreatingOpen(false);
          createForm.resetFields();
        }}
        destroyOnHidden
      >
        <Form
          form={createForm}
          layout="vertical"
          preserve={false}
          initialValues={{
            code: '',
            name: '',
            admin_email: '',
            admin_password: '',
            plan: 'free',
            expires_at: null,
          }}
        >
          <Form.Item
            name="code"
            label="租户号"
            rules={[
              { required: true, message: '请输入租户号' },
              { pattern: TENANT_CODE_PATTERN, message: TENANT_CODE_HINT },
              { min: 3, max: 32, message: '长度 3-32 字符' },
            ]}
            extra="登录、挂件 URL 都用这个号（如 acme-corp）。一旦创建不能改。"
          >
            <Input placeholder="例：acme-corp" autoComplete="off" />
          </Form.Item>
          <Form.Item
            name="name"
            label="租户名称"
            rules={[{ required: true, max: 200, message: '请输入名称（最长 200 字符）' }]}
            extra="租户显示名（用于列表 / 详情）"
          >
            <Input placeholder="例：Acme Corp" autoComplete="off" />
          </Form.Item>
          <Form.Item
            name="admin_email"
            label="初始管理员邮箱"
            rules={[
              { required: true, message: '请输入邮箱' },
              { type: 'email', message: '邮箱格式不正确' },
            ]}
            extra="该租户下的第一个 admin（首次登录会被强制改密）"
          >
            <Input placeholder="例：admin@acme-corp.test" autoComplete="off" />
          </Form.Item>
          <Form.Item
            name="admin_password"
            label="初始管理员密码"
            rules={[
              { required: true, message: '请输入密码' },
              { min: 8, message: '至少 8 字符' },
            ]}
            extra="服务端会 bcrypt 哈希入库；明文不落地。"
          >
            <Input.Password placeholder="至少 8 字符" autoComplete="new-password" />
          </Form.Item>
          <Form.Item name="plan" label="套餐" initialValue="free" extra="默认 Free">
            <Select options={PLAN_OPTIONS} />
          </Form.Item>
          <Form.Item
            name="expires_at"
            label="到期时间"
            extra="不填 = 永不过期。过期后该租户的所有账号都登不进去。"
          >
            <DatePicker showTime style={{ width: '100%' }} placeholder="留空表示永不过期" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
