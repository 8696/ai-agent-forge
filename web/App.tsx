import type { ReactElement } from 'react';
import { ConfigProvider, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { HealthPanel } from './components/HealthPanel';

/**
 * 根组件 —— 详见 docs/03-技术栈与规范.md §C.4
 * Step 1 仅展示 /health 是否可用，Step 13 会替换成完整路由表
 */
export function App(): ReactElement {
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{ algorithm: theme.defaultAlgorithm, token: { colorPrimary: '#1677ff' } }}
    >
      <div style={{ padding: 32, fontFamily: 'sans-serif' }}>
        <h1>AgentForge</h1>
        <p>Step 1 · 工程骨架已就绪。后端健康检查：</p>
        <HealthPanel />
      </div>
    </ConfigProvider>
  );
}
