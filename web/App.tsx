import type { ReactElement } from 'react';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { RouterProvider } from 'react-router-dom';
import { router } from './routes';
import { lightTheme } from './theme';

/**
 * 根组件 —— 详见 docs/03-技术栈与规范.md §C.4 / §C.5 + docs/04-a §0.2
 * 只挂 ConfigProvider + RouterProvider；具体页面在 routes.tsx
 *
 * Theme 来自 ./theme.ts —— 本轮 UI 重构的统一 token 入口；
 * 想换主色 / 圆角 / 字号统一改 theme.ts。
 */
export function App(): ReactElement {
  return (
    <ConfigProvider locale={zhCN} theme={lightTheme}>
      <RouterProvider router={router} />
    </ConfigProvider>
  );
}
