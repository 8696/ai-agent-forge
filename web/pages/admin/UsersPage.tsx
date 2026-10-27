import type { ReactElement } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Drawer,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
  theme,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { PlusOutlined, ReloadOutlined, UserAddOutlined } from '@ant-design/icons';
import { adminApi } from '../../lib/adminApi';
import { getToken } from '../../lib/apiFactory';
import { PageHeader } from '../../components/shell/PageHeader';

const { Paragraph } = Typography;

type UserRole = 'admin' | 'customer';

interface UserRow {
  id: string;
  email: string;
  role: UserRole;
  must_change_password: boolean;
  last_login_at: string | null;
  created_at: string;
  /** active=正常 / locked=锁定中（登录失败太多被锁的） */
  status: 'active' | 'locked';
  /** 锁定到什么时候；null = 没锁 */
  locked_until: string | null;
}

/**
 * 从 adminApi 的 token 解出当前 admin 的 user id —— 用来在「删除」按钮上
 * disable 掉自己（前端兜底；后端 src/gateway/admin/user-routes.ts 也防）
 *
 * ⚠️ **JWT 用的是 base64url**（`-` / `_` / 无 padding），`atob` 只吃标准 base64：
 *    不做转换会直接抛错 → `currentAdminId()` 恒为 null →
 *    「不能删自己」「不能改自己角色」的前端兜底**静默失效**。
 */
function currentAdminId(): string | null {
  const tok = getToken();
  if (tok === null) return null;
  try {
    const part = tok.split('.')[1] ?? '';
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    const payload = JSON.parse(atob(padded)) as { sub?: string };
    return payload.sub ?? null;
  } catch {
    return null;
  }
}

/**
 * /admin/users —— 租户 admin 管本租户用户
 *
 * 后端 4 个端点：
 *   GET    /users           列表（本租户）
 *   POST   /users           新建
 *   PATCH  /users/:id       改邮箱 / 重置密码（不支持改 role）
 *   DELETE /users/:id       删除（不能删自己）
 *
 * UI 详见 docs/04-c-ui-后台管理页面.md §5.8
 */
export function AdminUsersPage(): ReactElement {
  // 颜色走 antd token —— 写死浅色的话，深色模式下几乎看不见
  const { token } = theme.useToken();
  const [rows, setRows] = useState<UserRow[] | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  /** 组件还挂着吗（unmount 后不要再 setState） */
  const mountedRef = useRef(true);

  // client-side 检索 / 筛选（后端 list 端点还没接 filter 参数）
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<'all' | UserRole>('all');
  /** 状态筛选（04-c §5.8）—— 活跃 / 已锁定 */
  const [statusFilter, setStatusFilter] = useState<'all' | UserRow['status']>('all');

  // 创建 Modal
  const [creatingOpen, setCreatingOpen] = useState(false);
  const [createForm] = Form.useForm<{ email: string; role: UserRole; password: string }>();
  const [createSubmitting, setCreateSubmitting] = useState(false);

  // 编辑 Drawer
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [editForm] = Form.useForm<{ email: string; password?: string; role?: UserRole }>();
  const [editSubmitting, setEditSubmitting] = useState(false);

  const load = async (): Promise<void> => {
    setErrMsg(null);
    try {
      const res = await adminApi.get<{ users: UserRow[] }>('/users');
      if (!mountedRef.current) {
        return;
      }
      setRows(res.data.users);
    } catch (e: unknown) {
      if (!mountedRef.current) {
        return;
      }
      const status = (e as { response?: { status?: number } }).response?.status;
      setErrMsg(status === 401 ? '鉴权失败（需 admin 角色）' : '加载失败');
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // client-side filtered rows
  const filtered = useMemo(() => {
    const data = rows ?? [];
    const q = search.trim().toLowerCase();
    return data.filter((r) => {
      if (roleFilter !== 'all' && r.role !== roleFilter) return false;
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (q !== '' && !r.email.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rows, search, roleFilter, statusFilter]);

  // ===== 创建 =====
  const submitCreate = async (): Promise<void> => {
    const v = await createForm.validateFields().catch(() => null);
    if (v === null) return;
    setCreateSubmitting(true);
    try {
      await adminApi.post('/users', v);
      message.success(`已创建 ${v.role}：${v.email}`);
      setCreatingOpen(false);
      createForm.resetFields();
      await load();
    } catch (e) {
      const status = (e as { response?: { status?: number } }).response?.status;
      const data = (e as { response?: { data?: { message?: string } } }).response?.data;
      if (status === 400 && data?.message !== undefined) {
        message.error(data.message);
      } else {
        message.error('创建失败');
      }
    } finally {
      setCreateSubmitting(false);
    }
  };

  // ===== 编辑 =====
  const openEdit = (row: UserRow): void => {
    editForm.setFieldsValue({ email: row.email, password: '', role: row.role });
    setEditing(row);
  };

  const submitEdit = async (): Promise<void> => {
    if (editing === null) return;
    const v = await editForm.validateFields().catch(() => null);
    if (v === null) return;
    const body: { email?: string; password?: string; role?: UserRole } = {};
    if (v.email !== editing.email) body.email = v.email;
    if (v.password !== undefined && v.password !== '') body.password = v.password;
    // ⚠️ **不能改自己的角色** —— 后端也会拒（改了把自己降成 customer 就锁在门外了）
    if (v.role !== undefined && v.role !== editing.role && editing.id !== currentAdminId()) {
      body.role = v.role;
    }
    if (Object.keys(body).length === 0) {
      message.info('没有改动');
      setEditing(null);
      return;
    }
    setEditSubmitting(true);
    try {
      await adminApi.patch(`/users/${editing.id}`, body);
      message.success('已保存');
      setEditing(null);
      editForm.resetFields();
      await load();
    } catch (e) {
      const status = (e as { response?: { status?: number } }).response?.status;
      const data = (e as { response?: { data?: { message?: string } } }).response?.data;
      message.error(status === 400 && data?.message !== undefined ? data.message : '保存失败');
    } finally {
      setEditSubmitting(false);
    }
  };

  // ===== 删除 =====
  const onDelete = async (row: UserRow): Promise<void> => {
    try {
      await adminApi.delete(`/users/${row.id}`);
      message.success(`已删除 ${row.email}`);
      await load();
    } catch (e) {
      const status = (e as { response?: { status?: number } }).response?.status;
      const data = (e as { response?: { data?: { message?: string } } }).response?.data;
      message.error(status === 400 && data?.message !== undefined ? data.message : '删除失败');
    }
  };

  const selfId = currentAdminId();

  const columns: TableColumnsType<UserRow> = [
    {
      title: '邮箱',
      dataIndex: 'email',
      key: 'email',
      ellipsis: true,
      render: (email: string, row) => (
        <Space size={6}>
          <span style={{ fontWeight: 500 }}>{email}</span>
          {row.must_change_password && <Tag color="orange">待改密</Tag>}
        </Space>
      ),
    },
    {
      title: '角色',
      dataIndex: 'role',
      key: 'role',
      width: 110,
      render: (r: UserRole) => (
        <Tag color={r === 'admin' ? 'red' : 'blue'} style={{ fontWeight: 500 }}>
          {r === 'admin' ? '后台管理员' : '前台用户'}
        </Tag>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 90,
      render: (s: UserRow['status'], row: UserRow) =>
        s === 'locked' ? (
          <Tooltip title={row.locked_until === null ? '' : `锁到 ${new Date(row.locked_until).toLocaleString()}`}>
            <Tag color="warning" style={{ fontWeight: 500 }}>
              已锁定
            </Tag>
          </Tooltip>
        ) : (
          <Tag color="success" style={{ fontWeight: 500 }}>
            活跃
          </Tag>
        ),
    },
    {
      title: '最后登录',
      dataIndex: 'last_login_at',
      key: 'last_login_at',
      width: 180,
      render: (t: string | null) =>
        t === null ? <span style={{ color: token.colorTextTertiary }}>—</span> : new Date(t).toLocaleString(),
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 180,
      render: (t: string) => new Date(t).toLocaleString(),
    },
    {
      title: '操作',
      key: 'actions',
      width: 140,
      render: (_: unknown, row) => {
        const isSelf = selfId !== null && selfId === row.id;
        return (
          <Space onClick={(e) => e.stopPropagation()}>
            <Button type="link" size="small" onClick={() => openEdit(row)}>
              编辑
            </Button>
            <Popconfirm
              title={
                isSelf
                  ? `不能删除自己（${row.email}）—— 后端也拒`
                  : `确认删除 ${row.email}？此操作不可撤销`
              }
              okText="确认"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              disabled={isSelf}
              {...(isSelf ? {} : { onConfirm: () => void onDelete(row) })}
            >
              <Button type="link" size="small" danger disabled={isSelf}>
                删除
              </Button>
            </Popconfirm>
          </Space>
        );
      },
    },
  ];

  return (
    <div>
      <PageHeader
        title="用户管理"
        subtitle="本租户的后台管理员和前台用户。"
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
              创建用户
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

      <Card styles={{ body: { padding: 16 } }}>
        <Space wrap size={12} style={{ marginBottom: 12 }}>
          <Input.Search
            placeholder="按邮箱搜索"
            allowClear
            onSearch={(v) => setSearch(v)}
            onChange={(e) => {
              if (e.target.value === '') setSearch('');
            }}
            style={{ width: 240 }}
          />
          <Select
            value={roleFilter}
            onChange={(v) => setRoleFilter(v)}
            style={{ width: 160 }}
            options={[
              { value: 'all', label: '全部角色' },
              { value: 'admin', label: '后台管理员' },
              { value: 'customer', label: '前台用户' },
            ]}
          />
          <Select
            value={statusFilter}
            onChange={(v) => setStatusFilter(v)}
            style={{ width: 140 }}
            options={[
              { value: 'all', label: '全部状态' },
              { value: 'active', label: '活跃' },
              { value: 'locked', label: '已锁定' },
            ]}
          />
        </Space>
        <Table
          rowKey="id"
          columns={columns}
          dataSource={filtered}
          loading={rows === null}
          pagination={false}
          tableLayout="fixed"
          locale={{
            emptyText: rows === null ? '加载中…' : '还没有用户',
          }}
        />
      </Card>

      {/* 创建 */}
      <Modal
        open={creatingOpen}
        title={
          <Space>
            <UserAddOutlined />
            创建用户
          </Space>
        }
        okText="创建"
        cancelText="取消"
        confirmLoading={createSubmitting}
        onOk={submitCreate}
        onCancel={() => {
          setCreatingOpen(false);
          createForm.resetFields();
        }}
        destroyOnHidden
      >
        <Form form={createForm} layout="vertical" preserve={false}>
          <Form.Item
            name="email"
            label="邮箱"
            rules={[
              { required: true, message: '请输入邮箱' },
              { type: 'email', message: '邮箱格式不正确' },
            ]}
            extra="本租户内唯一；同租户的 admin / customer 邮箱不能重"
          >
            <Input placeholder="例：alice@acme-corp.test" autoComplete="off" />
          </Form.Item>
          <Form.Item
            name="role"
            label="角色"
            rules={[{ required: true, message: '请选择角色' }]}
            extra="admin 走 /admin 入口；customer 走 /customer 入口"
          >
            <Select
              options={[
                { value: 'admin', label: 'admin（后台管理员）' },
                { value: 'customer', label: 'customer（前台用户）' },
              ]}
            />
          </Form.Item>
          <Form.Item
            name="password"
            label="初始密码"
            rules={[
              { required: true, message: '请输入密码' },
              { min: 8, message: '至少 8 字符' },
            ]}
            extra="服务端 bcrypt 哈希入库"
          >
            <Input.Password placeholder="至少 8 字符" autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 编辑 */}
      <Drawer
        open={editing !== null}
        title={editing === null ? '' : `编辑用户 · ${editing.email}`}
        size={420}
        onClose={() => {
          setEditing(null);
          editForm.resetFields();
        }}
        destroyOnHidden
        extra={
          <Space>
            <Button onClick={() => setEditing(null)}>取消</Button>
            <Button type="primary" loading={editSubmitting} onClick={submitEdit}>
              保存
            </Button>
          </Space>
        }
      >
        <Form form={editForm} layout="vertical" preserve={false}>
          <Form.Item
            name="email"
            label="邮箱"
            rules={[
              { required: true, message: '请输入邮箱' },
              { type: 'email', message: '邮箱格式不正确' },
            ]}
          >
            <Input autoComplete="off" />
          </Form.Item>
          <Form.Item
            name="role"
            label={
              <Space size={6}>
                <span>角色</span>
                {editing !== null && editing.id === selfId && (
                  <Tooltip title="不能改自己的角色 —— 把自己降成 customer 就锁在 /admin 门外了（后端也会拒）">
                    <Tag color="orange" style={{ marginInlineEnd: 0 }}>
                      不可改
                    </Tag>
                  </Tooltip>
                )}
              </Space>
            }
            extra={
              editing !== null && editing.id === selfId
                ? '自己的角色不可修改。admin 走 /admin 入口；customer 走 /customer 入口。'
                : 'admin 走 /admin 入口；customer 走 /customer 入口。改完这个用户要重新登录才生效。'
            }
          >
            <Select
              disabled={editing !== null && editing.id === selfId}
              options={[
                { value: 'admin', label: '后台管理员' },
                { value: 'customer', label: '前台用户' },
              ]}
            />
          </Form.Item>
          <Form.Item
            name="password"
            label="重置密码（不填则不改）"
            rules={[{ min: 8, message: '至少 8 字符' }]}
            extra="填写则覆盖该用户的 password_hash。"
          >
            <Input.Password placeholder="留空表示不动" autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Drawer>
    </div>
  );
}
