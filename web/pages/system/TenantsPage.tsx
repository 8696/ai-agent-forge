import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import type { TableColumnsType } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { systemApi } from '../../lib/systemApi';

const { Title, Paragraph } = Typography;

interface TenantRow {
  id: string;
  code: string;
  name: string;
  plan: 'free' | 'pro' | 'enterprise';
  /** F2 */
  status: 'active' | 'disabled';
  /** F2；后端序列化 → ISO 字符串（也可能为 null） */
  expires_at: string | null;
  created_at: string;
  admin: { id: string; email: string; must_change_password: boolean } | null;
}

const PLAN_COLOR: Record<string, string> = {
  free: 'default',
  pro: 'blue',
  enterprise: 'gold',
};

/**
 * 渲染到期时间。
 *  - null    → 灰色「永不过期」
 *  - 已到期  → 红色 + 具体日期
 *  - 未到期  → 正常显示
 */
function renderExpiresAt(iso: string | null): ReactElement {
  if (iso === null) {
    return <Tag color="default">永不过期</Tag>;
  }
  const d = dayjs(iso);
  if (d.isBefore(dayjs())) {
    return <Tag color="red">{d.format('YYYY-MM-DD HH:mm')}（已到期）</Tag>;
  }
  return <span>{d.format('YYYY-MM-DD HH:mm')}</span>;
}

/**
 * /system/tenants —— system 端租户列表
 * 详见 docs/16-e §F1 + §F2
 */
export function SystemTenantsPage(): ReactElement {
  const navigate = useNavigate();
  const [rows, setRows] = useState<TenantRow[] | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  // F2 状态筛选 / 编辑操作涉及的 modal
  const [editingRow, setEditingRow] = useState<TenantRow | null>(null);
  const [expiresForm] = Form.useForm<{ expires_at: Dayjs | null }>();

  // A2：建租户（system 前端入口，后端在 src/gateway/system/tenant-routes.ts:38）
  // 字段集严格对齐后端 createTenantSchema（src/lib/validators.ts §36-41）
  const [creatingOpen, setCreatingOpen] = useState(false);
  interface CreateTenantForm {
    code: string;
    name: string;
    admin_email: string;
    admin_password: string;
  }
  const [createForm] = Form.useForm<CreateTenantForm>();

  const load = async (): Promise<void> => {
    setErrMsg(null);
    try {
      const res = await systemApi.get<{ tenants: TenantRow[] }>('/tenants');
      setRows(res.data.tenants);
    } catch (e: unknown) {
      const status = (e as { response?: { status?: number } }).response?.status;
      setErrMsg(status === 401 ? '鉴权失败（需 system 角色）' : '加载失败');
    }
  };

  useEffect(() => {
    void load();
  }, []);

  // ===== F2 actions =====

  /** 把 expires_at 写成 ISO 字符串（null = 永不过） */
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

  // ===== A2：创建租户 =====

  /** 提交后端 createTenantSchema 形如 { code, name, admin_email, admin_password } */
  const submitCreate = async (): Promise<void> => {
    const v = await createForm.validateFields().catch(() => null);
    if (v === null) return;
    try {
      const res = await systemApi.post<{ tenant: { code: string }; admin: { email: string } }>(
        '/tenants',
        v,
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
        message.error(data.message); // 后端原样返（如「租户号已被使用」）
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
      render: (code: string, row) => <Link to={`/system/tenants/${row.id}`}>{code}</Link>,
    },
    { title: '名称', dataIndex: 'name', key: 'name' },
    {
      title: '套餐',
      dataIndex: 'plan',
      key: 'plan',
      render: (plan: string) => <Tag color={PLAN_COLOR[plan] ?? 'default'}>{plan}</Tag>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (s: TenantRow['status']) =>
        s === 'active' ? <Tag color="success">启用</Tag> : <Tag color="error">已禁用</Tag>,
    },
    {
      title: '到期时间',
      dataIndex: 'expires_at',
      key: 'expires_at',
      render: (iso: TenantRow['expires_at']) => renderExpiresAt(iso),
    },
    {
      title: '初始 admin',
      dataIndex: 'admin',
      key: 'admin',
      render: (admin: TenantRow['admin']) =>
        admin === null ? (
          <Tag color="red">无</Tag>
        ) : (
          <Space direction="vertical" size={0}>
            <span>{admin.email}</span>
            {admin.must_change_password && <Tag color="orange">待改密</Tag>}
          </Space>
        ),
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      key: 'created_at',
      render: (t: string) => new Date(t).toLocaleString(),
    },
    {
      title: '操作',
      key: 'actions',
      // 行点击进详情时，操作列要 stopPropagation，避免误触发 navigate
      render: (_: unknown, row) => (
        <Space onClick={(e) => e.stopPropagation()}>
          <Button
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
            onConfirm={() => void onToggleStatus(row)}
          >
            {row.code === 'system' ? (
              // 防自锁：SaaS 平台方自己的初始租户禁止禁用
              <Button size="small" disabled>
                {row.status === 'active' ? '禁用' : '启用'}
              </Button>
            ) : (
              <Button
                size="small"
                danger={row.status === 'active'}
                type={row.status === 'active' ? 'default' : 'primary'}
              >
                {row.status === 'active' ? '禁用' : '启用'}
              </Button>
            )}
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16, justifyContent: 'space-between', display: 'flex' }}>
        <Title level={3} style={{ margin: 0 }}>
          租户管理
        </Title>
        <Space>
          <Button type="primary" onClick={() => setCreatingOpen(true)}>
            + 创建租户
          </Button>
          <Button onClick={() => void load()}>刷新</Button>
        </Space>
      </Space>
      <Paragraph type="secondary">
        SaaS 平台方：列出所有租户、查看基本资料、重置租户 admin 密码、修改到期时间、启用 /
        禁用租户。
      </Paragraph>
      {errMsg !== null && (
        <Alert type="error" showIcon message={errMsg} style={{ marginBottom: 16 }} />
      )}
      <Card>
        <Table
          rowKey="id"
          columns={columns}
          dataSource={rows ?? []}
          loading={rows === null}
          pagination={false}
          onRow={(row) => ({
            onClick: () => navigate(`/system/tenants/${row.id}`),
            style: { cursor: 'pointer' },
          })}
        />
      </Card>

      {/* F2：修改到期时间 */}
      <Modal
        open={editingRow !== null}
        title={editingRow === null ? '' : `修改租户 ${editingRow.code} 的到期时间`}
        okText="保存"
        cancelText="取消"
        onOk={onSubmitExpires}
        onCancel={() => setEditingRow(null)}
        destroyOnClose
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
          <Paragraph type="secondary" style={{ marginTop: -8 }}>
            所有改动都会写入 audit_logs（系统级日志），可在「审计日志」页面查询。
          </Paragraph>
        </Form>
      </Modal>

      {/* A2：创建租户（system 在 /system/tenants 的「+ 创建租户」入口；后端 POST /api/v1/system/tenants） */}
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
        destroyOnClose
      >
        <Form
          form={createForm}
          layout="vertical"
          preserve={false}
          // 服务端是同步建库（事务），不传 plan / expires_at 走默认：plan='free' / expires_at=null
          initialValues={{ code: '', name: '', admin_email: '', admin_password: '' }}
        >
          <Form.Item
            name="code"
            label="租户号"
            // 对齐 src/lib/validators.ts §tenantCodeSchema
            rules={[
              { required: true, message: '请输入租户号' },
              { pattern: /^[a-z0-9-]+$/, message: '只能包含小写字母 / 数字 / 连字符' },
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
          <Paragraph type="secondary" style={{ marginTop: -8, marginBottom: 0 }}>
            套餐 / 到期时间走默认值（free + 永不过期），建好之后可以用列表行上的「改到期」「启停」按钮后续调整。
          </Paragraph>
        </Form>
      </Modal>
    </div>
  );
}
