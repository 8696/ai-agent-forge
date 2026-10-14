import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
  message,
} from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { systemApi } from '../../lib/systemApi';

const { Title, Paragraph } = Typography;

interface TenantDetail {
  id: string;
  code: string;
  name: string;
  plan: 'free' | 'pro' | 'enterprise';
  settings: Record<string, unknown> | null;
  /** F2 */
  status: 'active' | 'disabled';
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  admin: {
    id: string;
    email: string;
    role: 'admin' | 'customer';
    must_change_password: boolean;
    last_login_at: string | null;
  } | null;
}

const PLAN_COLOR: Record<string, string> = {
  free: 'default',
  pro: 'blue',
  enterprise: 'gold',
};

/**
 * /system/tenants/:id —— 单租户详情 + 改基本资料 + 重置 admin 密码 + F2 启停 / 到期
 * 详见 docs/16-e §F1 + §F2
 */
export function SystemTenantDetailPage(): ReactElement {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [data, setData] = useState<TenantDetail | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetForm] = Form.useForm<{ new_password: string }>();

  // F2：到期时间 Modal
  const [expiresOpen, setExpiresOpen] = useState(false);
  const [expiresForm] = Form.useForm<{ expires_at: Dayjs | null }>();

  const load = async (): Promise<void> => {
    setErrMsg(null);
    try {
      const res = await systemApi.get<TenantDetail>(`/tenants/${id ?? ''}`);
      setData(res.data);
    } catch (e: unknown) {
      const status = (e as { response?: { status?: number } }).response?.status;
      setErrMsg(status === 404 ? '租户不存在' : '加载失败');
    }
  };

  useEffect(() => {
    void load();
    // id 变化时清空表单
    expiresForm.resetFields();
  }, [id]);

  if (errMsg !== null) {
    return (
      <div>
        <Button onClick={() => navigate('/system/tenants')}>返回列表</Button>
        <Alert type="error" showIcon message={errMsg} style={{ marginTop: 16 }} />
      </div>
    );
  }
  if (data === null) {
    return <Spin tip="加载中..." style={{ display: 'block', marginTop: 80 }} />;
  }

  const onPatch = async (values: {
    name?: string;
    plan?: 'free' | 'pro' | 'enterprise';
  }): Promise<void> => {
    try {
      await systemApi.patch(`/tenants/${id ?? ''}`, values);
      message.success('已更新');
      await load();
    } catch {
      message.error('更新失败');
    }
  };

  const onReset = async (): Promise<void> => {
    const v = await resetForm.validateFields();
    try {
      await systemApi.post(`/tenants/${id ?? ''}/admin/reset-password`, {
        new_password: v.new_password,
      });
      message.success('已重置 admin 密码，admin 下次登录会强制改密');
      resetForm.resetFields();
      setResetOpen(false);
      await load();
    } catch (e) {
      const status = (e as { response?: { status?: number } }).response?.status;
      message.error(status === 404 ? '租户 admin 不存在' : '重置失败');
    }
  };

  // ===== F2 actions =====

  const onSubmitExpires = async (): Promise<void> => {
    const v = await expiresForm.validateFields().catch(() => null);
    if (v === null) return;
    const iso =
      v.expires_at === undefined || v.expires_at === null
        ? null
        : v.expires_at.toDate().toISOString();
    try {
      await systemApi.patch(`/tenants/${id ?? ''}/expires_at`, { expires_at: iso });
      message.success(iso === null ? '已清空到期时间（永不过期）' : '已更新到期时间');
      setExpiresOpen(false);
      await load();
    } catch (e) {
      const status = (e as { response?: { status?: number } }).response?.status;
      message.error(status === 400 ? '请求格式不合法' : '保存到期时间失败');
    }
  };

  const onToggleStatus = async (): Promise<void> => {
    if (data === null) return;
    const next = data.status === 'active' ? 'disabled' : 'active';
    try {
      await systemApi.patch(`/tenants/${data.id}/status`, { status: next });
      message.success(next === 'disabled' ? `已禁用租户 ${data.code}` : `已启用租户 ${data.code}`);
      await load();
    } catch (e) {
      const status = (e as { response?: { status?: number } }).response?.status;
      const errMsgText = (e as { response?: { data?: { message?: string } } }).response?.data
        ?.message;
      message.error(status === 400 ? (errMsgText ?? '不能执行此操作') : '启停失败');
    }
  };

  // 防自锁：code='system' 的初始租户禁用/启用按钮都禁
  const isSystemTenant = data.code === 'system';

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button onClick={() => navigate('/system/tenants')}>← 返回列表</Button>
        <Title level={3} style={{ margin: 0 }}>
          租户 {data.code}
        </Title>
        <Tag color={PLAN_COLOR[data.plan] ?? 'default'}>{data.plan}</Tag>
        <Tag color={data.status === 'active' ? 'success' : 'error'}>
          {data.status === 'active' ? '启用' : '已禁用'}
        </Tag>
        {data.expires_at === null ? (
          <Tag color="default">永不过期</Tag>
        ) : dayjs(data.expires_at).isBefore(dayjs()) ? (
          <Tag color="red">已到期 {dayjs(data.expires_at).format('YYYY-MM-DD')}</Tag>
        ) : (
          <Tag color="blue">{dayjs(data.expires_at).format('YYYY-MM-DD HH:mm')} 到期</Tag>
        )}
      </Space>

      <Card title="基本资料" style={{ marginBottom: 16 }}>
        <Descriptions column={2} size="small">
          <Descriptions.Item label="租户 ID">{data.id}</Descriptions.Item>
          <Descriptions.Item label="租户号">{data.code}</Descriptions.Item>
          <Descriptions.Item label="名称">{data.name}</Descriptions.Item>
          <Descriptions.Item label="套餐">
            <Tag color={PLAN_COLOR[data.plan] ?? 'default'}>{data.plan}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="状态">
            <Tag color={data.status === 'active' ? 'success' : 'error'}>
              {data.status === 'active' ? '启用' : '已禁用'}
            </Tag>
          </Descriptions.Item>
          <Descriptions.Item label="到期时间">
            {data.expires_at === null
              ? '永不过期'
              : `${dayjs(data.expires_at).format('YYYY-MM-DD HH:mm')}${
                  dayjs(data.expires_at).isBefore(dayjs()) ? '（已过期）' : ''
                }`}
          </Descriptions.Item>
          <Descriptions.Item label="创建时间">
            {new Date(data.created_at).toLocaleString()}
          </Descriptions.Item>
          <Descriptions.Item label="更新时间">
            {new Date(data.updated_at).toLocaleString()}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      <Card title="改基本资料" style={{ marginBottom: 16 }}>
        <Form
          layout="inline"
          initialValues={{ name: data.name, plan: data.plan }}
          onFinish={onPatch}
        >
          <Form.Item name="name" label="名称" rules={[{ min: 1, max: 200 }]}>
            <Input style={{ width: 240 }} />
          </Form.Item>
          <Form.Item name="plan" label="套餐">
            <Select
              style={{ width: 160 }}
              options={[
                { value: 'free', label: 'free' },
                { value: 'pro', label: 'pro' },
                { value: 'enterprise', label: 'enterprise' },
              ]}
            />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit">
              保存
            </Button>
          </Form.Item>
        </Form>
      </Card>

      {/* F2：启停 + 到期时间 */}
      <Card title="租户启停与到期（F2）" style={{ marginBottom: 16 }}>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Descriptions column={1} size="small">
            <Descriptions.Item label="状态">
              <Space>
                <Tag color={data.status === 'active' ? 'success' : 'error'}>
                  {data.status === 'active' ? '启用' : '已禁用'}
                </Tag>
                <Popconfirm
                  title={
                    data.status === 'active'
                      ? `确认禁用租户 ${data.code}？该租户下所有 admin / customer 账号将无法登录`
                      : `确认启用租户 ${data.code}？`
                  }
                  okText="确认"
                  cancelText="取消"
                  onConfirm={() => void onToggleStatus()}
                >
                  <Button danger={data.status === 'active'} disabled={isSystemTenant}>
                    {data.status === 'active' ? '禁用' : '启用'}
                  </Button>
                </Popconfirm>
                {isSystemTenant && (
                  <Paragraph type="secondary" style={{ margin: 0 }}>
                    系统初始租户禁止禁用（防 SaaS 平台方自锁）
                  </Paragraph>
                )}
              </Space>
            </Descriptions.Item>
            <Descriptions.Item label="到期时间">
              <Space>
                {data.expires_at === null
                  ? '永不过期'
                  : `${dayjs(data.expires_at).format('YYYY-MM-DD HH:mm')}${
                      dayjs(data.expires_at).isBefore(dayjs()) ? '（已过期）' : ''
                    }`}
                <Button
                  onClick={() => {
                    expiresForm.setFieldsValue({
                      expires_at: data.expires_at === null ? null : dayjs(data.expires_at),
                    });
                    setExpiresOpen(true);
                  }}
                >
                  改到期
                </Button>
              </Space>
            </Descriptions.Item>
          </Descriptions>
          <Paragraph type="secondary" style={{ margin: 0 }}>
            启停或改到期后立即生效（不需要重启服务）；所有改动都会写入 audit_logs。
          </Paragraph>
        </Space>
      </Card>

      <Card title="初始 admin 账号">
        {data.admin === null ? (
          <Paragraph type="danger">该租户没有 admin 账号（异常状态）</Paragraph>
        ) : (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Descriptions column={2} size="small">
              <Descriptions.Item label="admin ID">{data.admin.id}</Descriptions.Item>
              <Descriptions.Item label="邮箱">{data.admin.email}</Descriptions.Item>
              <Descriptions.Item label="角色">
                <Tag color="red">{data.admin.role}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="状态">
                {data.admin.must_change_password ? (
                  <Tag color="orange">登录后待改密</Tag>
                ) : (
                  <Tag color="green">正常</Tag>
                )}
              </Descriptions.Item>
              <Descriptions.Item label="最后登录">
                {data.admin.last_login_at !== null
                  ? new Date(data.admin.last_login_at).toLocaleString()
                  : '从未登录'}
              </Descriptions.Item>
            </Descriptions>
            <Space>
              <Button danger onClick={() => setResetOpen(true)}>
                重置 admin 密码
              </Button>
              <Paragraph type="secondary" style={{ margin: 0 }}>
                重置后 admin 重新登录会被强制改密（must_change_password=true）
              </Paragraph>
            </Space>
          </Space>
        )}
      </Card>

      <Modal
        open={resetOpen}
        title={`重置 ${data.code} 的 admin 密码`}
        okText="重置"
        cancelText="取消"
        onOk={onReset}
        onCancel={() => {
          resetForm.resetFields();
          setResetOpen(false);
        }}
        destroyOnClose
      >
        <Form form={resetForm} layout="vertical">
          <Form.Item
            name="new_password"
            label="新密码"
            rules={[{ required: true, min: 8, message: '至少 8 字符' }]}
          >
            <Input.Password placeholder="新密码（至少 8 字符）" autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>

      {/* F2：到期时间 Modal */}
      <Modal
        open={expiresOpen}
        title={`修改 ${data.code} 的到期时间`}
        okText="保存"
        cancelText="取消"
        onOk={onSubmitExpires}
        onCancel={() => {
          expiresForm.resetFields();
          setExpiresOpen(false);
        }}
        destroyOnClose
      >
        <Form form={expiresForm} layout="vertical">
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
    </div>
  );
}
