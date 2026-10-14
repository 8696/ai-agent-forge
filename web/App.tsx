import type { ReactElement } from 'react';
import { ConfigProvider, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { RouterProvider } from 'react-router-dom';
import { router } from './routes';

/**
 * 根组件 —— 详见 docs/03-技术栈与规范.md §C.4 / §C.5
 * 只挂 ConfigProvider + RouterProvider；具体页面在 routes.tsx
 */
export function App(): ReactElement {
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{ algorithm: theme.defaultAlgorithm, token: { colorPrimary: '#1677ff' } }}
    >
      <RouterProvider router={router} />
    </ConfigProvider>
  );
}
