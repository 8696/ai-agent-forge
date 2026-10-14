import { useState } from 'react';
import type { ReactElement } from 'react';
import type { AxiosInstance } from 'axios';
import { Alert, Button, Card, Descriptions, Space, Spin, Tag, Typography } from 'antd';
import { getCurrentUser } from '../lib/auth';
import { getToken } from '../lib/apiFactory';

const { Text, Paragraph } = Typography;

const ROLE_TAG_COLOR: Record<string, string> = {
  system: 'magenta',
  admin: 'red',
  customer: 'blue',
};

type ProbeState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; status: number; data: unknown }
  | { kind: 'err'; status: number | null; message: string };

/**
 * JWT 调试组件（dev 工具）
 *
 * 各子系统的 home 页自己传入自己的 api + mePath 实例，无共享。
 */
export function JwtInspector(props: { api: AxiosInstance; mePath: string }): ReactElement {
  const [showLocal, setShowLocal] = useState(false);
  const [probe, setProbe] = useState<ProbeState>({ kind: 'idle' });

  const user = getCurrentUser();
  const token = getToken();

  if (user === null || token === null) {
    return <Alert type="warning" showIcon message="未登录，无 token 可看" />;
  }

  const onProbeMe = async (): Promise<void> => {
    setProbe({ kind: 'loading' });
    try {
      const res = await props.api.get(props.mePath);
      setProbe({ kind: 'ok', status: res.status, data: res.data });
    } catch (e: unknown) {
      const err = e as { response?: { status?: number; data?: unknown }; message?: string };
      setProbe({
        kind: 'err',
        status: err.response?.status ?? null,
        message:
          err.response?.data !== undefined
            ? JSON.stringify(err.response.data)
            : (err.message ?? 'unknown'),
      });
    }
  };

  return (
    <Card
      title={
        <Space>
          <span>🔍 JWT 调试</span>
          <Tag color={ROLE_TAG_COLOR[user.role] ?? 'default'}>{user.role}</Tag>
        </Space>
      }
      size="small"
      style={{ marginTop: 16 }}
    >
      <Space wrap>
        <Button onClick={() => setShowLocal((v) => !v)}>
          {showLocal ? '隐藏' : '查看'}本地 token 解析
        </Button>
        <Button onClick={onProbeMe} loading={probe.kind === 'loading'} type="primary">
          调 {props.mePath} 验证服务端
        </Button>
        <Text type="secondary">两者对比，能立刻发现 token 失效 / 跨租户 / role 不匹配</Text>
      </Space>

      {showLocal && (
        <div style={{ marginTop: 12 }}>
          <Paragraph style={{ marginBottom: 6 }}>
            <strong>角色</strong>：
            <Tag color={ROLE_TAG_COLOR[user.role] ?? 'default'}>{user.role}</Tag>
          </Paragraph>
          <Descriptions size="small" column={1} bordered>
            <Descriptions.Item label="sub（用户 ID）">
              <Text code copyable>
                {user.sub}
              </Text>
            </Descriptions.Item>
            {user.tenant_id !== undefined && (
              <Descriptions.Item label="tenant_id（租户 ID）">
                <Text code copyable>
                  {user.tenant_id}
                </Text>
              </Descriptions.Item>
            )}
            <Descriptions.Item label="token（前 80 字符）">
              <Text code style={{ wordBreak: 'break-all' }}>
                {token.slice(0, 80)}…
              </Text>
            </Descriptions.Item>
          </Descriptions>
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        {probe.kind === 'idle' && (
          <Alert type="info" showIcon message="点上面按钮看服务端解析结果" />
        )}
        {probe.kind === 'loading' && <Spin tip="调 /me 中..." />}
        {probe.kind === 'ok' && (
          <Alert
            type="success"
            showIcon
            message={`✓ 服务端响应 status=${probe.status}`}
            description={
              <pre style={{ margin: 0, fontSize: 12 }}>{JSON.stringify(probe.data, null, 2)}</pre>
            }
          />
        )}
        {probe.kind === 'err' && (
          <Alert
            type="error"
            showIcon
            message={`✗ 服务端响应 status=${probe.status ?? '?'}`}
            description={<pre style={{ margin: 0, fontSize: 12 }}>{probe.message}</pre>}
          />
        )}
      </div>
    </Card>
  );
}
