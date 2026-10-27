import type { ReactElement } from 'react';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Button, Checkbox, Form, Input, Tag, theme } from 'antd';
import { LockOutlined, MailOutlined, ShopOutlined } from '@ant-design/icons';
import { adminApi } from '../../lib/adminApi';
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
  /** 「记住我」—— 勾了 token 存 localStorage（跨浏览器重启保留），不勾存 sessionStorage */
  remember: boolean;
}

/**
 * P-L2 · 租户后台登录（admin）—— 详见 docs/04-b-ui-登录与聊天挂件.md §3.2
 */
export function AdminLoginPage(): ReactElement {
  const navigate = useNavigate();
  // 「登录已过期」是从别处跳过来的（token 过期被踢回来）—— 提示一下，
  // 不然用户不知道为什么要重新登一遍
  const [searchParams] = useSearchParams();
  const expired = searchParams.get(EXPIRED_REASON_PARAM) === EXPIRED_REASON_VALUE;
  const [loading, setLoading] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  // 「记住我」勾没勾（docs/04-b §3.2）—— 决定 token 存 localStorage 还是 sessionStorage
  // ⚠️ **默认不勾**（2026-10-27 改）：规格只说「勾了存 localStorage 7 天」，
  //    没规定默认值 —— 默认勾上等于用户不碰复选框就把 token 永久留在磁盘上。
  //    隐私侧更稳妥的默认 = 不勾（token 存 sessionStorage，关掉标签页就没了）。
  const [remember, setRemember] = useState(false);
  // 颜色走 antd token —— 写死浅色的话，深色模式下几乎看不见
  const { token } = theme.useToken();

  const onFinish = async (values: FormValues): Promise<void> => {
    setLoading(true);
    setErrMsg(null);
    try {
      const res = await adminApi.post<{
        token: string;
        // ⚠️ 后端从 2026-10-25 起才真的返回这个字段 —— 之前前端在等、后端没给
        user?: { role: string; must_change_password?: boolean };
      }>('/login', values);
      setToken(res.data.token, remember);
      // 被平台方重置过密码 → 先去改密（服务端也会拦其它接口）
      if (res.data.user?.must_change_password === true) {
        navigate('/admin/change-password', { replace: true });
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
      roleLabel="admin 子系统 · 租户后台"
      title="登录到 AI 助手"
      description="租户后台登录"
      hint="租户号由你的 SaaS 服务方提供"
      loading={loading}
      badge={
        <Tag color="red" style={{ margin: 0, fontWeight: 500 }}>
          <ShopOutlined style={{ marginRight: 4 }} />
          admin
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
          name="tenant_code"
          label="租户号"
          rules={[
            { required: true, message: '请输入租户号' },
            { pattern: TENANT_CODE_PATTERN, message: TENANT_CODE_HINT },
          ]}
        >
          <Input
            prefix={<ShopOutlined style={{ color: token.colorTextTertiary }} />}
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

        <Form.Item>
          <Checkbox checked={remember} onChange={(e) => setRemember(e.target.checked)}>
            记住我
          </Checkbox>
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
