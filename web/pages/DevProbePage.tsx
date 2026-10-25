import type { ReactElement } from 'react';
import { Card, Typography } from 'antd';
import { HealthPanel } from '../components/HealthPanel';
import { ModelProbe } from '../components/ModelProbe';

const { Title, Paragraph } = Typography;

/**
 * /dev/probe —— 把当前的健康检查 + LLM 探活拢到一个调试页面。
 * 路由：/dev/probe（不进业务流；Step 13 业务上线时可保留 / 移除）
 */
export function DevProbePage(): ReactElement {
  return (
    <div style={{ maxWidth: 720 }}>
      <Title level={3}>调试工具</Title>
      <Paragraph type="secondary">
        仅 dev 环境用 —— 这个路由<strong>只在 Vite dev 模式下注册</strong>
        （生产构建里根本不存在，会落到 404 页）。后端的 <code>/api/_dev/*</code> 同样
        只在 <code>NODE_ENV ≠ production</code> 时才挂载。
      </Paragraph>

      <Card title="后端健康检查" size="small" style={{ marginBottom: 16 }}>
        <HealthPanel />
      </Card>

      <ModelProbe />
    </div>
  );
}
