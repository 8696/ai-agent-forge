import type { ReactElement } from 'react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Form, Input, Tag, theme } from 'antd';
import { LockOutlined, MailOutlined, ControlOutlined } from '@ant-design/icons';
import { systemApi } from '../../lib/systemApi';
import { setToken } from '../../lib/apiFactory';
import { AuthShell } from '../../components/shell/AuthShell';

interface FormValues {
  email: string;
  password: string;
}

/**
 * P-L1 · 系统端登录（SaaS 平台方）—— 详见 docs/04-b-ui-登录与聊天挂件.md §3.1
 */
export function SystemLoginPage(): ReactElement {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  // 颜色走 antd token —— 写死浅色的话，深色模式下几乎看不见
  const { token } = theme.useToken();

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
    <AuthShell
      roleLabel="system 子系统 · SaaS 平台方"
      title="平台管理登录"
      description="没有 SaaS 平台方账号？联系系统部署方"
      badge={
        <Tag color="magenta" style={{ margin: 0, fontWeight: 500 }}>
          <ControlOutlined style={{ marginRight: 4 }} />
          system
        </Tag>
      }
    >
      {errMsg !== null && (
        <Alert
          type="error"
          showIcon
          title={errMsg}
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
          name="email"
          label="邮箱"
          rules={[
            { required: true, message: '请输入邮箱' },
            { type: 'email', message: '邮箱格式不正确' },
          ]}
        >
          <Input
            prefix={<MailOutlined style={{ color: token.colorTextTertiary }} />}
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
            prefix={<LockOutlined style={{ color: token.colorTextTertiary }} />}
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
