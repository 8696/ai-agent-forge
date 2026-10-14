import type { ReactElement } from 'react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Card, Form, Input, Typography } from 'antd';
import { customerApi } from '../../lib/customerApi';
import { setToken } from '../../lib/apiFactory';

const { Title, Paragraph } = Typography;

interface FormValues {
  email: string;
  password: string;
  tenant_code: string;
}

/**
 * P-L3 · 租户前台登录（customer）
 * 路由：/customer/login
 * 调：POST /api/v1/customer/login
 * 详见 docs/16-需求技术对照表 A4
 */
export function CustomerLoginPage(): ReactElement {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const onFinish = async (values: FormValues): Promise<void> => {
    setLoading(true);
    setErrMsg(null);
    try {
      const res = await customerApi.post<{
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
    <Card style={{ maxWidth: 400, margin: '64px auto' }}>
      <Title level={3}>用户登录</Title>
      <Paragraph type="secondary">前台 customer 入口（需带租户号）</Paragraph>
      {errMsg !== null && <Alert type="error" message={errMsg} style={{ marginBottom: 16 }} />}
      <Form<FormValues> layout="vertical" onFinish={onFinish} disabled={loading}>
        <Form.Item
          name="tenant_code"
          label="租户号"
          rules={[{ required: true, pattern: /^[a-z0-9-]{3,32}$/ }]}
        >
          <Input placeholder="例：acme-corp" autoComplete="off" />
        </Form.Item>
        <Form.Item name="email" label="邮箱" rules={[{ required: true, type: 'email' }]}>
          <Input autoComplete="email" />
        </Form.Item>
        <Form.Item name="password" label="密码" rules={[{ required: true }]}>
          <Input.Password autoComplete="current-password" />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={loading} block>
          登录
        </Button>
      </Form>
    </Card>
  );
}
