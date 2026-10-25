import type { ReactElement } from 'react';
import { useEffect } from 'react';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { RouterProvider } from 'react-router-dom';
import { router } from './routes';
import { darkTheme, lightTheme } from './theme';
import { useThemeMode } from './lib/themeMode';

/**
 * 根组件 —— 详见 docs/03-c-技术栈-前端栈.md §C.4 / §C.5 + docs/04-a §0.2
 * 只挂 ConfigProvider + RouterProvider；具体页面在 routes.tsx
 *
 * Theme 来自 ./theme.ts —— 全局统一的 token 入口；
 * 想换主色 / 圆角 / 字号统一改 theme.ts。
 *
 * 深色模式（docs/04-d §9.3）：顶栏的 ☀ / 🌙 按钮切，
 * 选择存 localStorage；根组件订阅同一个 store，切换立即生效。
 */
export function App(): ReactElement {
  const mode = useThemeMode();

  // body 背景是注入的静态 CSS（main.tsx），它没法自己知道当前模式 ——
  // 所以把模式写到 <html data-theme> 上，让 CSS 按属性切换。
  useEffect(() => {
    document.documentElement.dataset.theme = mode;
  }, [mode]);

  return (
    <ConfigProvider locale={zhCN} theme={mode === 'dark' ? darkTheme : lightTheme}>
      <RouterProvider router={router} />
    </ConfigProvider>
  );
}
