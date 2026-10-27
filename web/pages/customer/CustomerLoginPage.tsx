import type { ReactElement } from 'react';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Button, Form, Input, Tag, theme } from 'antd';
import { LockOutlined, MailOutlined, UserOutlined } from '@ant-design/icons';
import { customerApi } from '../../lib/customerApi';
import {
  EXPIRED_REASON_PARAM,
  EXPIRED_REASON_VALUE,
  setToken,
} from '../../lib/apiFactory';
import { AuthShell } from '../../components/shell/AuthShell';
import { TENANT_CODE_PATTERN, TENANT_CODE_HINT } from '@shared/validation/tenant-code';

interface FormValues {
  email: string;
  password: string;
  tenant_code: string;
}

/**
 * P-L3 · 租户前台登录（customer）—— 详见 docs/04-b-ui-登录与聊天挂件.md §3.3
 */
export function CustomerLoginPage(): ReactElement {
  const navigate = useNavigate();
  // 租户号预填（?tenant_code=xxx）—— 公开挂件的「登录」按钮会带过来，
  // 访客不用自己猜租户号（docs/04-a §2.3「用户头像菜单：登录」）
  const [searchParams] = useSearchParams();
  // 「登录已过期」是从别处跳过来的（token 过期被踢回来）—— 提示一下，
  // 不然用户不知道为什么要重新登一遍
  const expired = searchParams.get(EXPIRED_REASON_PARAM) === EXPIRED_REASON_VALUE;
  const [loading, setLoading] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  // 颜色走 antd token —— 写死浅色的话，深色模式下几乎看不见
  const { token } = theme.useToken();

  const onFinish = async (values: FormValues): Promise<void> => {
    setLoading(true);
    setErrMsg(null);
    try {
      const res = await customerApi.post<{
        token: string;
        // ⚠️ 后端从 2026-10-25 起才真的返回这个字段 —— 之前前端在等、后端没给
        user?: { role: string; must_change_password?: boolean };
      }>('/login', values);
      setToken(res.data.token);
      // 被平台方重置过密码 → 先去改密（服务端也会拦其它接口）
      if (res.data.user?.must_change_password === true) {
        navigate('/customer/change-password', { replace: true });
        return;
      }
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
      roleLabel="customer 子系统 · 租户前台"
      title="登录到 AI 助手"
      description="用户登录"
      // 租户用户没有「租户管理员」这个身份（他就是租户的用户）—— 提示要跟着改
      forgotPasswordHint="没有账号？联系你的租户管理员"
      loading={loading}
      badge={
        <Tag color="blue" style={{ margin: 0, fontWeight: 500 }}>
          <UserOutlined style={{ marginRight: 4 }} />
          customer
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
        initialValues={{ tenant_code: searchParams.get('tenant_code') ?? '' }}
        disabled={loading}
        requiredMark={false}
        size="large"
      >
        <Form.Item
          name="tenant_code"
          label="租户号"
          rules={[
            { required: true, message: '请输入租户号' },
            { pattern: TENANT_CODE_PATTERN, message: TENANT_CODE_HINT },
          ]}
        >
          <Input
            prefix={<UserOutlined style={{ color: token.colorTextTertiary }} />}
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
