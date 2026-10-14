import type { ReactElement } from 'react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Form, Input, Tag } from 'antd';
import { LockOutlined, MailOutlined, ShopOutlined } from '@ant-design/icons';
import { adminApi } from '../../lib/adminApi';
import { setToken } from '../../lib/apiFactory';
import { AuthShell } from '../../components/shell/AuthShell';

interface FormValues {
  email: string;
  password: string;
  tenant_code: string;
}

/**
 * P-L2 · 租户后台登录（admin）—— 详见 docs/04-b-ui-登录与聊天挂件.md §3.2
 */
export function AdminLoginPage(): ReactElement {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const onFinish = async (values: FormValues): Promise<void> => {
    setLoading(true);
    setErrMsg(null);
    try {
      const res = await adminApi.post<{
        token: string;
        user: { role: string; must_change_password: boolean };
      }>('/login', values);
      setToken(res.data.token);
      navigate('/');
    } catch (e: unknown) {
      const status = (e as { response?: { status?: number } }).response?.status;
      setErrMsg(status === 401 ? '邮箱或密码错误' : '登录失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell
      roleLabel="admin 子系统 · 租户后台"
      title="租户后台登录"
      description="租户 admin 入口 · 需带租户号"
      badge={
        <Tag color="red" style={{ margin: 0, fontWeight: 500 }}>
          <ShopOutlined style={{ marginRight: 4 }} />
          admin
        </Tag>
      }
    >
      {errMsg !== null && (
        <Alert
          type="error"
          showIcon
          message={errMsg}
          style={{ marginBottom: 18 }}
        />
      )}

      <Form<FormValues>
        layout="vertical"
        onFinish={onFinish}
        disabled={loading}
        requiredMark={false}
        size="large"
      >
        <Form.Item
          name="tenant_code"
          label="租户号"
          rules={[
            { required: true, message: '请输入租户号' },
            { pattern: /^[a-z0-9-]{3,32}$/, message: '3-32 位，小写字母 / 数字 / 短横线' },
          ]}
        >
          <Input
            prefix={<ShopOutlined style={{ color: 'rgba(0,0,0,0.45)' }} />}
            placeholder="例：acme-corp"
            autoComplete="off"
          />
        </Form.Item>

        <Form.Item
          name="email"
          label="邮箱"
          rules={[
            { required: true, message: '请输入邮箱' },
            { type: 'email', message: '邮箱格式不正确' },
          ]}
        >
          <Input
            prefix={<MailOutlined style={{ color: 'rgba(0,0,0,0.45)' }} />}
            placeholder="你的邮箱"
            autoComplete="email"
          />
        </Form.Item>

        <Form.Item
          name="password"
          label="密码"
          rules={[{ required: true, message: '请输入密码' }]}
        >
          <Input.Password
            prefix={<LockOutlined style={{ color: 'rgba(0,0,0,0.45)' }} />}
            placeholder="密码"
            autoComplete="current-password"
          />
        </Form.Item>

        <Form.Item style={{ marginBottom: 0 }}>
          <Button type="primary" htmlType="submit" loading={loading} block size="large">
            登录
          </Button>
        </Form.Item>
      </Form>
    </AuthShell>
  );
}
