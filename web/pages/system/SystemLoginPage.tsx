import type { ReactElement } from 'react';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Button, Form, Input, Tag, theme } from 'antd';
import { LockOutlined, MailOutlined, ControlOutlined } from '@ant-design/icons';
import { systemApi } from '../../lib/systemApi';
import {
  EXPIRED_REASON_PARAM,
  EXPIRED_REASON_VALUE,
  setToken,
} from '../../lib/apiFactory';
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
  // 「登录已过期」是从别处跳过来的（token 过期被踢回来）—— 提示一下，
  // 不然用户不知道为什么要重新登一遍
  const [searchParams] = useSearchParams();
  const expired = searchParams.get(EXPIRED_REASON_PARAM) === EXPIRED_REASON_VALUE;
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
      title="登录到 AI 助手"
      description="SaaS 平台方登录"
      // ⚠️ 平台方**没有**「租户管理员」这个角色 —— 默认文案对它是错的（docs/04-b §3.1）
      forgotPasswordHint="没有 SaaS 平台方账号？联系系统部署方"
      loading={loading}
      badge={
        <Tag color="magenta" style={{ margin: 0, fontWeight: 500 }}>
          <ControlOutlined style={{ marginRight: 4 }} />
          system
        </Tag>
      }
    >
      {expired && (
        <Alert
          type="warning"
          showIcon
          title="登录已过期，请重新登录"
          style={{ marginBottom: 18 }}
        />
      )}
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
          rules={[
            { required: true, message: '请输入密码' },
            // ⚠️ docs/04-b §3.1：平台方密码 **≥ 8 字符**
            //    （admin / customer 是「≥ 1 字符」，那两个页面别跟着加这条）
            { min: 8, message: '密码至少 8 字符' },
          ]}
        >
          <Input.Password
            prefix={<LockOutlined style={{ color: token.colorTextTertiary }} />}
            placeholder="至少 8 位"
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
