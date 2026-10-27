import type { ReactElement } from 'react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Form, Input, Skeleton, theme } from 'antd';
import { LockOutlined } from '@ant-design/icons';
import type { AxiosInstance } from 'axios';
import { expiredLoginUrl, loginPathForBaseUrl, setToken } from '../../lib/apiFactory';
import { apiErrorMessage, apiServerMessage, isWrongOldPasswordError } from '../../lib/apiError';
import { AuthShell } from './AuthShell';

interface FormValues {
  old_password: string;
  new_password: string;
  confirm_password: string;
}

interface ChangePasswordCardProps {
  /** 对应子系统的 axios 实例（adminApi / customerApi / systemApi） */
  api: AxiosInstance;
  /** 页面主标题 */
  title: string;
  /** 副标题 / 说明 */
  description: string;
  /** 角色 badge 的文字 */
  roleLabel: string;
  /** 改完之后跳哪儿 */
  afterUrl: string;
  /**
   * **true = 强制改密**：平台方重置过这个账号的密码，
   * 用户不改完就干不了别的（服务端也会拦，见 src/gateway/password-change-gate.ts）。
   */
  forced: boolean;
}

/**
 * 自助改密页 —— 三套子系统共用一个组件，但**路由各归各**
 * （`/admin/change-password` / `/customer/change-password` / `/system/change-password`）。
 *
 * 为什么要有这个：平台方重置租户 admin 密码时会置 `must_change_password=true`，
 * 但这个标志之前**从建表起就没人消费** —— 用户拿着临时密码长期用下去。
 *
 * 改完密码后端会返回**一枚新 token**（旧 token 里还带着「必须改密」标志），
 * 这里替换掉 —— 否则用户改完还是被闸门挡着。
 */
export function ChangePasswordCard(props: ChangePasswordCardProps): ReactElement {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  // 颜色走 antd token —— 写死浅色的话，深色模式下几乎看不见
  const { token } = theme.useToken();

  const onFinish = async (values: FormValues): Promise<void> => {
    setLoading(true);
    setErrMsg(null);
    try {
      const res = await props.api.post<{ ok: boolean; token?: string }>('/change-password', {
        old_password: values.old_password,
        new_password: values.new_password,
      });
      if (typeof res.data.token === 'string') {
        setToken(res.data.token);
      }
      navigate(props.afterUrl, { replace: true });
    } catch (e: unknown) {
      const status = (e as { response?: { status?: number } }).response?.status;
      if (status === 401) {
        // ⚠️ **两种 401 必须分开**（2026-10-27 修）：
        //    ① 「原密码不正确」（后端 src/services/change-password.ts）
        //       → token 好得很，就地提示，用户改完再试
        //    ② 其它 401 = **token 过期 / 无效**（src/lib/jwt.ts 的「无效或过期的 token」）
        //       → 清 token + 跳本子系统登录页，并提示「登录已过期，请重新登录」
        //    以前这里**一律**显示「原密码不正确」→ token 过期时用户以为是自己密码错了，
        //    反复重试永远出不去（改密页还绕过了 RequireAuth，未登录也能进来）。
        if (isWrongOldPasswordError(e)) {
          setErrMsg('原密码不正确');
        } else {
          setToken(null);
          setErrMsg('登录已过期，请重新登录');
          const loginPath = loginPathForBaseUrl(props.api.defaults.baseURL);
          if (loginPath !== null) {
            navigate(expiredLoginUrl(loginPath), { replace: true });
          }
        }
      } else if (status === 400) {
        const msg = apiServerMessage(e);
        setErrMsg(msg ?? '新密码不符合要求');
      } else {
        // 其余（403 / 500 / 网络错误 / 其它）→ **走统一文案**
        // （web/lib/apiError.ts 是唯一真源：403「没有权限」/ 500「服务异常，已记录」
        //   / 网络「网络异常，请稍后重试」—— docs/04-d §8.4）
        setErrMsg(apiErrorMessage(e, '修改失败，请稍后重试'));
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell roleLabel={props.roleLabel} title={props.title} description={props.description}>
      {props.forced && (
        <Alert
          type="warning"
          showIcon
          title="请先设置新密码"
          description="你的初始密码由平台方重置过。改完之前只能用改密码这一个操作。"
          style={{ marginBottom: 18 }}
        />
      )}
      {errMsg !== null && (
        <Alert type="error" showIcon title={errMsg} style={{ marginBottom: 18 }} />
      )}

      {/* 局部加载态：`<Skeleton />`（docs/04-d §8.3「局部加载：`<Skeleton />`」）。
          ⚠️ **骨架是盖在表单上面的，不是替换掉表单** ——
             提交失败时表单还得留着用户填的内容（替换掉 = 卸载 Form = 字段全清空，
             用户得从头再填一遍）。 */}
      <div style={{ position: 'relative' }}>
        {loading && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 5,
              padding: 4,
              background: token.colorBgContainer,
            }}
          >
            <Skeleton active title={false} paragraph={{ rows: 3 }} />
          </div>
        )}
        <Form<FormValues>
          layout="vertical"
          onFinish={onFinish}
          disabled={loading}
          requiredMark={false}
          size="large"
        >
          <Form.Item
            name="old_password"
            label="当前密码"
            rules={[{ required: true, message: '请输入当前密码' }]}
          >
            <Input.Password
              prefix={<LockOutlined style={{ color: token.colorTextTertiary }} />}
              placeholder="当前密码"
              autoComplete="current-password"
            />
          </Form.Item>

          <Form.Item
            name="new_password"
            label="新密码"
            rules={[
              { required: true, message: '请输入新密码' },
              { min: 8, message: '新密码至少 8 字符' },
            ]}
          >
            <Input.Password
              prefix={<LockOutlined style={{ color: token.colorTextTertiary }} />}
              placeholder="至少 8 位"
              autoComplete="new-password"
            />
          </Form.Item>

          <Form.Item
            name="confirm_password"
            label="确认新密码"
            dependencies={['new_password']}
            rules={[
              { required: true, message: '请再输入一次新密码' },
              ({ getFieldValue }) => ({
                validator(_, value: string) {
                  if (!value || getFieldValue('new_password') === value) {
                    return Promise.resolve();
                  }
                  return Promise.reject(new Error('两次输入的新密码不一致'));
                },
              }),
            ]}
          >
            <Input.Password
              prefix={<LockOutlined style={{ color: token.colorTextTertiary }} />}
              placeholder="再输入一次"
              autoComplete="new-password"
            />
          </Form.Item>

          <Form.Item style={{ marginBottom: 0 }}>
            <Button type="primary" htmlType="submit" loading={loading} block size="large">
              修改密码
            </Button>
          </Form.Item>
        </Form>
      </div>
    </AuthShell>
  );
}
