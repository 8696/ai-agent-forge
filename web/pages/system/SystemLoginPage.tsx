import type { ReactElement } from 'react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Card, Form, Input, Typography } from 'antd';
import { systemApi } from '../../lib/systemApi';
import { setToken } from '../../lib/apiFactory';

const { Title, Paragraph } = Typography;

interface FormValues {
  email: string;
  password: string;
}

/**
 * P-L1 · 系统端登录（SaaS 平台方）
 * 路由：/system/login
 * 调：POST /api/v1/system/login
 * 详见 docs/04-UI需求.md §3 / docs/16-需求技术对照表 A4
 */
export function SystemLoginPage(): ReactElement {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const onFinish = async (values: FormValues): Promise<void> => {
    setLoading(true);
    setErrMsg(null);
    try {
      const res = await systemApi.post<{ token: string }>('/login', values);
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
      <Title level={3}>平台管理登录</Title>
      <Paragraph type="secondary">SaaS 平台方账号（建租户 / 跨租户运营）</Paragraph>
      {errMsg !== null && <Alert type="error" message={errMsg} style={{ marginBottom: 16 }} />}
      <Form<FormValues> layout="vertical" onFinish={onFinish} disabled={loading}>
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
