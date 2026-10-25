import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Form,
  Input,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Statistic,
  Tag,
  Typography,
  message,
} from 'antd';
import {
  ArrowLeftOutlined,
  KeyOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  CalendarOutlined,
} from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { systemApi } from '../../lib/systemApi';
import { PageHeader } from '../../components/shell/PageHeader';

const { Text } = Typography;

interface TenantDetail {
  id: string;
  code: string;
  name: string;
  plan: 'free' | 'pro' | 'enterprise';
  settings: Record<string, unknown> | null;
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
  /** 该租户的规模统计（04-d §6.1「租户详情页有这一块」） */
  stats: {
    user_count: number;
    session_count: number;
    document_count: number;
    total_cost_usd: number;
  };
}

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

/**
 * /system/tenants/:id —— 单租户详情 + 改基本资料 + 重置 admin 密码 + F2 启停 / 到期
 */
export function SystemTenantDetailPage(): ReactElement {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [data, setData] = useState<TenantDetail | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetForm] = Form.useForm<{ new_password: string }>();

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
        <Button
          icon={<ArrowLeftOutlined />}
          onClick={() => navigate('/system/tenants')}
          style={{ marginBottom: 16 }}
        >
          返回列表
        </Button>
        <Alert type="error" showIcon title={errMsg} />
      </div>
    );
  }
  if (data === null) {
    return <Alert showIcon title="加载中..." type="info" />;
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

  const isSystemTenant = data.code === 'system';

  return (
    <div>
      <PageHeader
        title={
          <Space size={12}>
            <span>{data.code}</span>
            <Tag color={PLAN_COLOR[data.plan] ?? 'default'} style={{ fontWeight: 500 }}>
              {PLAN_LABEL[data.plan] ?? data.plan}
            </Tag>
            <Tag
              color={data.status === 'active' ? 'success' : 'error'}
              style={{ fontWeight: 500 }}
            >
              {data.status === 'active' ? '启用' : '已禁用'}
            </Tag>
          </Space>
        }
        subtitle={data.name}
        extra={
          <Button
            icon={<ArrowLeftOutlined />}
            onClick={() => navigate('/system/tenants')}
          >
            返回列表
          </Button>
        }
      />

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={14}>
          <Card title="基本资料" style={{ borderRadius: 12 }}>
            <Descriptions column={2} size="small">
              <Descriptions.Item label="租户 ID" span={2}>
                <Text code>{data.id}</Text>
              </Descriptions.Item>
              <Descriptions.Item label="租户号">{data.code}</Descriptions.Item>
              <Descriptions.Item label="名称">{data.name}</Descriptions.Item>
              <Descriptions.Item label="套餐">
                <Tag color={PLAN_COLOR[data.plan] ?? 'default'}>
                  {PLAN_LABEL[data.plan] ?? data.plan}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="状态">
                <Tag
                  color={data.status === 'active' ? 'success' : 'error'}
                  style={{ fontWeight: 500 }}
                >
                  {data.status === 'active' ? '启用' : '已禁用'}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="到期时间" span={2}>
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

          {/* 该租户的规模统计（04-d §6.1）—— 全部按 tenant_id 过滤，是这个租户的数 */}
          <Card title="规模统计" style={{ borderRadius: 12, marginTop: 16 }}>
            <Row gutter={[16, 16]}>
              <Col xs={12} sm={6}>
                <Statistic title="用户数" value={data.stats.user_count} />
              </Col>
              <Col xs={12} sm={6}>
                <Statistic title="会话数" value={data.stats.session_count} />
              </Col>
              <Col xs={12} sm={6}>
                <Statistic title="文档数" value={data.stats.document_count} />
              </Col>
              <Col xs={12} sm={6}>
                <Statistic
                  title="累计花费"
                  value={data.stats.total_cost_usd}
                  precision={4}
                  prefix="$"
                />
              </Col>
            </Row>
          </Card>
        </Col>

        <Col xs={24} lg={10}>
          <Card title="改基本资料" style={{ borderRadius: 12, marginBottom: 16 }}>
            <Form
              layout="vertical"
              initialValues={{ name: data.name, plan: data.plan }}
              onFinish={onPatch}
            >
              <Form.Item name="name" label="名称" rules={[{ min: 1, max: 200 }]}>
                <Input placeholder="租户显示名" />
              </Form.Item>
              <Form.Item name="plan" label="套餐">
                <Select
                  options={[
                    { value: 'free', label: 'Free' },
                    { value: 'pro', label: 'Pro' },
                    { value: 'enterprise', label: 'Enterprise' },
                  ]}
                />
              </Form.Item>
              <Form.Item style={{ marginBottom: 0 }}>
                <Button type="primary" htmlType="submit" block>
                  保存
                </Button>
              </Form.Item>
            </Form>
          </Card>

          <Card title="启停 & 到期" style={{ borderRadius: 12 }}>
            <Space orientation="vertical" size={16} style={{ width: '100%' }}>
              <div>
                <Text type="secondary" style={{ fontSize: 13 }}>
                  状态
                </Text>
                <div style={{ marginTop: 8 }}>
                  <Space wrap>
                    <Tag
                      color={data.status === 'active' ? 'success' : 'error'}
                      style={{ fontWeight: 500 }}
                    >
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
                      okButtonProps={data.status === 'active' ? { danger: true } : { type: 'primary' }}
                      onConfirm={() => void onToggleStatus()}
                    >
                      <Button
                        danger={data.status === 'active'}
                        type={data.status === 'active' ? 'default' : 'primary'}
                        icon={
                          data.status === 'active' ? (
                            <PauseCircleOutlined />
                          ) : (
                            <PlayCircleOutlined />
                          )
                        }
                        disabled={isSystemTenant}
                      >
                        {data.status === 'active' ? '禁用' : '启用'}
                      </Button>
                    </Popconfirm>
                    {isSystemTenant && (
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        系统初始租户禁止禁用
                      </Text>
                    )}
                  </Space>
                </div>
              </div>

              <div>
                <Text type="secondary" style={{ fontSize: 13 }}>
                  到期时间
                </Text>
                <div style={{ marginTop: 8 }}>
                  <Space wrap>
                    <span>
                      {data.expires_at === null
                        ? '永不过期'
                        : `${dayjs(data.expires_at).format('YYYY-MM-DD HH:mm')}${
                            dayjs(data.expires_at).isBefore(dayjs()) ? '（已过期）' : ''
                          }`}
                    </span>
                    <Button
                      icon={<CalendarOutlined />}
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
                </div>
              </div>

              <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
                启停或改到期立即生效（无需重启）；所有改动都会写入 audit_logs。
              </Text>
            </Space>
          </Card>
        </Col>

        <Col xs={24}>
          <Card title="初始 admin 账号" style={{ borderRadius: 12 }}>
            {data.admin === null ? (
              <Alert type="error" showIcon title="该租户没有 admin 账号（异常状态）" />
            ) : (
              <Row gutter={[16, 16]}>
                <Col xs={24} md={16}>
                  <Descriptions column={2} size="small">
                    <Descriptions.Item label="admin ID" span={2}>
                      <Text code>{data.admin.id}</Text>
                    </Descriptions.Item>
                    <Descriptions.Item label="邮箱" span={2}>
                      {data.admin.email}
                    </Descriptions.Item>
                    <Descriptions.Item label="角色">
                      <Tag color="red" style={{ fontWeight: 500 }}>
                        {data.admin.role === 'admin' ? '后台管理员' : '前台用户'}
                      </Tag>
                    </Descriptions.Item>
                    <Descriptions.Item label="状态">
                      {data.admin.must_change_password ? (
                        <Tag color="orange" style={{ fontWeight: 500 }}>
                          登录后待改密
                        </Tag>
                      ) : (
                        <Tag color="success" style={{ fontWeight: 500 }}>
                          正常
                        </Tag>
                      )}
                    </Descriptions.Item>
                    <Descriptions.Item label="最后登录" span={2}>
                      {data.admin.last_login_at !== null
                        ? new Date(data.admin.last_login_at).toLocaleString()
                        : '从未登录'}
                    </Descriptions.Item>
                  </Descriptions>
                </Col>
                <Col xs={24} md={8}>
                  <Space orientation="vertical" size={8}>
                    <Button
                      danger
                      block
                      icon={<KeyOutlined />}
                      onClick={() => setResetOpen(true)}
                    >
                      重置 admin 密码
                    </Button>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      重置后 admin 重新登录会被强制改密（must_change_password=true）
                    </Text>
                  </Space>
                </Col>
              </Row>
            )}
          </Card>
        </Col>
      </Row>

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
        destroyOnHidden
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
        destroyOnHidden
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
