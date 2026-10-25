import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
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
import { CopyOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { PageHeader } from '../../components/shell/PageHeader';
import {
  createApiKey,
  fetchApiKeys,
  revokeApiKey,
  updateApiKeyScope,
  type ApiKeyItem,
  type ApiKeyScope,
  type CreatedApiKey,
} from '../../lib/adminApiKeys';

const { Text, Paragraph } = Typography;

/** key 的状态 —— 三种，前两种还能用，第三种已经废了 */
type KeyState = 'active' | 'expired' | 'revoked';

function stateOf(k: ApiKeyItem): KeyState {
  if (k.revoked_at !== null) return 'revoked';
  if (k.expires_at !== null && new Date(k.expires_at).getTime() < Date.now()) return 'expired';
  return 'active';
}

const STATE_TAG: Record<KeyState, { color: string; label: string }> = {
  active: { color: 'success', label: '有效' },
  expired: { color: 'warning', label: '已过期' },
  revoked: { color: 'error', label: '已撤销' },
};

/**
 * 权限分级的展示 —— docs/10-安全方案.md §10
 *
 * read  = 只读：只能查知识库（GET /search），发起对话会被挡（403）
 * write = 可发起对话（默认）
 * admin = 预留
 */
const SCOPE_LABEL: Record<ApiKeyScope, string> = {
  read: '只读',
  write: '可提问',
  admin: '管理员',
};

const SCOPE_COLOR: Record<ApiKeyScope, string> = {
  read: 'default',
  write: 'blue',
  admin: 'purple',
};

const SCOPE_OPTIONS: Array<{ value: ApiKeyScope; label: string }> = [
  { value: 'read', label: '只读（只能查知识库，不能提问）' },
  { value: 'write', label: '可提问（默认）' },
  { value: 'admin', label: '管理员（预留）' },
];

/**
 * /admin/api-keys —— 租户后台的「API 密钥」
 *
 * 外部系统拿这个 key 调对外 REST API（POST /api/v1/public/chat）。
 * 管理端点：GET/POST /api/v1/admin/api-keys、DELETE /api/v1/admin/api-keys/:id
 * （src/gateway/public/api-key-admin-routes.ts）
 *
 * ⚠️ **完整 key 只在创建那一次出现** —— 服务端只存 bcrypt hash。
 *    丢了就撤销重建一把，没有找回的办法。
 *
 * UI 详见 docs/04-c-ui-后台管理页面.md §5.9.4
 */
export function AdminApiKeysPage(): ReactElement {
  const [rows, setRows] = useState<ApiKeyItem[] | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // 新建
  const [creating, setCreating] = useState(false);
  const [createForm] = Form.useForm<{
    name: string;
    expires_at: Dayjs | null | undefined;
    scope: ApiKeyScope;
  }>();

  // 刚创建出来的 key（完整形态）—— 只在这一次弹窗里出现
  const [fresh, setFresh] = useState<CreatedApiKey | null>(null);

  const load = async (): Promise<void> => {
    setLoading(true);
    setErrMsg(null);
    try {
      setRows(await fetchApiKeys());
    } catch (e: unknown) {
      const status = (e as { response?: { status?: number } }).response?.status;
      setRows(null);
      setErrMsg(status === 401 ? '鉴权失败（需 admin 角色）' : '加载 API 密钥失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const onCreate = async (): Promise<void> => {
    const v = await createForm.validateFields().catch(() => null);
    if (v === null) return;
    try {
      const created = await createApiKey({
        name: v.name,
        // ⚠️ DatePicker 用户没碰过时 antd 给的是 **undefined**（不是 null），
        //    直接 .toISOString() 会抛 "Cannot read properties of undefined"
        expires_at: v.expires_at == null ? undefined : v.expires_at.toISOString(),
        scope: v.scope ?? 'write',
      });
      setCreating(false);
      createForm.resetFields();
      setFresh(created);
      await load();
    } catch (e: unknown) {
      const status = (e as { response?: { status?: number } }).response?.status;
      message.error(status === 400 ? '请求参数不合法' : '创建 API 密钥失败');
    }
  };

  const onScopeChange = async (row: ApiKeyItem, scope: ApiKeyScope): Promise<void> => {
    try {
      await updateApiKeyScope(row.id, scope);
      message.success(`「${row.name}」的权限已改成「${SCOPE_LABEL[scope]}」`);
      await load();
    } catch {
      message.error('改权限失败');
    }
  };

  const onRevoke = async (row: ApiKeyItem): Promise<void> => {
    try {
      await revokeApiKey(row.id);
      message.success(`已撤销「${row.name}」`);
      await load();
    } catch {
      message.error('撤销失败');
    }
  };

  const copyFresh = async (): Promise<void> => {
    if (fresh === null) return;
    try {
      await navigator.clipboard.writeText(fresh.api_key);
      message.success('已复制到剪贴板');
    } catch {
      message.error('复制失败，请手动选中复制');
    }
  };

  const columns: TableColumnsType<ApiKeyItem> = [
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      ellipsis: true,
      render: (name: string) => <Text strong>{name}</Text>,
    },
    {
      title: 'Key',
      dataIndex: 'key_prefix',
      key: 'key_prefix',
      width: 190,
      render: (prefix: string) => (
        <Text code copyable style={{ fontSize: 12 }}>
          {prefix}••••••••
        </Text>
      ),
    },
    {
      title: '权限',
      dataIndex: 'scope',
      key: 'scope',
      width: 96,
      render: (scope: ApiKeyScope) => (
        <Tag color={SCOPE_COLOR[scope]} style={{ fontWeight: 500 }}>
          {SCOPE_LABEL[scope]}
        </Tag>
      ),
    },
    {
      title: '状态',
      key: 'state',
      width: 90,
      render: (_: unknown, row) => {
        const s = STATE_TAG[stateOf(row)];
        return (
          <Tag color={s.color} style={{ fontWeight: 500 }}>
            {s.label}
          </Tag>
        );
      },
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 160,
      render: (t: string) => new Date(t).toLocaleString(),
    },
    {
      title: '最后使用',
      dataIndex: 'last_used_at',
      key: 'last_used_at',
      width: 160,
      render: (t: string | null) =>
        t === null ? <Text type="secondary">从未使用</Text> : new Date(t).toLocaleString(),
    },
    {
      title: '到期时间',
      dataIndex: 'expires_at',
      key: 'expires_at',
      width: 160,
      render: (t: string | null) =>
        t === null ? <Text type="secondary">永不过期</Text> : new Date(t).toLocaleString(),
    },
    {
      title: '操作',
      key: 'actions',
      width: 170,
      render: (_: unknown, row) =>
        row.revoked_at === null ? (
          <Space size={4}>
            <Select
              size="small"
              value={row.scope}
              style={{ width: 92 }}
              options={SCOPE_OPTIONS.map((o) => ({ value: o.value, label: SCOPE_LABEL[o.value] }))}
              onChange={(v: ApiKeyScope) => void onScopeChange(row, v)}
            />
            <Popconfirm
              title={`确认撤销「${row.name}」？`}
              description="撤销后这把 key 立刻失效，调用方会拿到 401。"
              okText="撤销"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => void onRevoke(row)}
            >
              <Button type="link" size="small" danger>
                撤销
              </Button>
            </Popconfirm>
          </Space>
        ) : (
          <Text type="secondary" style={{ fontSize: 12 }}>
            已撤销
          </Text>
        ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="API 密钥"
        subtitle="外部系统拿这个 key 调对外 REST API（/api/v1/public/*）。"
        breadcrumb={[{ title: '首页' }, { title: 'API 密钥' }]}
        extra={
          <>
            <Button icon={<ReloadOutlined />} onClick={() => void load()}>
              刷新
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
              生成新密钥
            </Button>
          </>
        }
      />

      {errMsg !== null && (
        <Alert type="error" showIcon message={errMsg} style={{ marginBottom: 16 }} />
      )}

      <Card styles={{ body: { padding: 16 } }}>
        <Table
          rowKey="id"
          columns={columns}
          dataSource={rows ?? []}
          loading={rows === null}
          tableLayout="fixed"
          pagination={false}
          locale={{
            emptyText: rows === null ? '加载中…' : '还没有 API 密钥，点右上角「生成新密钥」',
          }}
        />
        <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0, fontSize: 12 }}>
          完整 key 只在创建的那一次显示 —— 服务端只存 bcrypt 哈希，谁也拿不回去。
          丢了就撤销重建一把。
          <br />
          权限可在表格里随时改，改完立刻生效（服务端会清掉鉴权缓存）。
        </Paragraph>
      </Card>

      {/* 新建 */}
      <Modal
        open={creating}
        title="生成新密钥"
        okText="生成"
        cancelText="取消"
        onOk={() => void onCreate()}
        onCancel={() => setCreating(false)}
        destroyOnClose
      >
        <Form form={createForm} layout="vertical" preserve={false}>
          <Form.Item
            name="name"
            label="用途名称"
            rules={[{ required: true, max: 100, message: '请填写名称（最长 100 字符）' }]}
            extra="自己看得懂就行，比如「生产环境」「第三方 ERP」"
          >
            <Input placeholder="例：生产环境" autoComplete="off" />
          </Form.Item>
          <Form.Item
            name="expires_at"
            label="到期时间"
            extra="不填 = 永不过期。过期后这把 key 自动失效。"
          >
            <DatePicker showTime style={{ width: '100%' }} placeholder="留空表示永不过期" />
          </Form.Item>
          <Form.Item
            name="scope"
            label="权限"
            initialValue="write"
            extra="对外的 key 是发到客户系统里的 —— 权限给小了才安全。只读级别只能查知识库，发起提问会被拒绝。"
          >
            <Select options={SCOPE_OPTIONS} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 刚创建出来的完整 key —— 只在这一次弹窗里出现 */}
      <Modal
        open={fresh !== null}
        title="密钥已生成"
        okText="我已复制"
        cancelButtonProps={{ style: { display: 'none' } }}
        onOk={() => setFresh(null)}
        onCancel={() => setFresh(null)}
        closable={false}
        maskClosable={false}
      >
        <Alert
          type="warning"
          showIcon
          message="完整密钥只显示这一次"
          description="关掉这个弹窗就再也看不到了（服务端只存 bcrypt 哈希）。请立刻复制并保存到你们的密钥管理里。"
          style={{ marginBottom: 16 }}
        />
        {fresh !== null && (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {fresh.name}
            </Text>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '10px 12px',
                borderRadius: 8,
                border: '1px solid rgba(0,0,0,0.08)',
                wordBreak: 'break-all',
                fontFamily: 'monospace',
                fontSize: 13,
              }}
            >
              <Text code copyable={{ icon: <CopyOutlined /> }}>
                {fresh.api_key}
              </Text>
            </div>
            <Button icon={<CopyOutlined />} onClick={() => void copyFresh()}>
              复制完整密钥
            </Button>
          </Space>
        )}
      </Modal>
    </div>
  );
}
