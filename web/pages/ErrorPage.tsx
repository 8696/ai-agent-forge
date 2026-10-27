import type { ReactElement } from 'react';
import { useEffect } from 'react';
import { Link, useLocation, useNavigate, useRouteError } from 'react-router-dom';
import { Button, Result } from 'antd';
import { ArrowLeftOutlined, ReloadOutlined } from '@ant-design/icons';
import { useThemeMode } from '../lib/themeMode';
import { pageGradient } from '../theme';

/**
 * 500 错误页 —— docs/04-a-ui-总则布局与菜单.md §1.3
 * 「404 / 500：全屏居中 `<Result />` + 按钮」
 *
 * ⚠️ 以前**只有 404**（`web/pages/NotFoundPage.tsx`）—— 500 没有路由也没有页面。
 *
 * ## 它同时是路由的 `errorElement`
 *
 * ⚠️ **React Router v7 自带一层内部错误边界**（`RouterProvider` 里的
 *    `RouterErrorBoundary`），它比 `web/components/ErrorBoundary.tsx` **更靠近**路由组件 ——
 *    路由里渲染时抛的异常会被它先接住，然后渲染它的**默认英文页**
 *    （「Unexpected Application Error!」+ 堆栈）。
 *    没有 `errorElement` 的话，`web/main.tsx` 那个外层 `<ErrorBoundary>`
 *    （docs/04-d §11.3 说的「白屏防护」）**根本轮不到出场**。
 *
 * 所以 `web/routes.tsx` 里给每条子系统路由都挂了 `errorElement: <ErrorPage />` ——
 * 路由出错时用户看到的是这个中文的、居中的、有「重试 / 回首页」出口的页面。
 */
export function ErrorPage(): ReactElement {
  // 整页渐变跟深色模式走（写死浅色的话，暗色下 500 页是一片白）
  const mode = useThemeMode();
  const location = useLocation();
  const navigate = useNavigate();
  const home = homePathFor(location.pathname);

  // 作为 errorElement 用时才有值；作为独立的 /500 路由用时是 undefined
  const routeError = useRouteError();
  const hasError = routeError !== undefined && routeError !== null;

  useEffect(() => {
    // 细节只进控制台 —— 不往屏幕上贴内部错误信息
    if (hasError) {
      console.error('[ErrorPage] 路由渲染异常：', routeError);
    }
  }, [hasError, routeError]);

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: pageGradient(mode === 'dark'),
        padding: 24,
      }}
    >
      <Result
        status={hasError ? 'error' : '500'}
        title={hasError ? '页面出错了' : '500'}
        subTitle={
          hasError
            ? '这个页面没能正常加载。错误已经记下来了，可以重试，或者返回首页。'
            : '服务异常，已记录。稍后再试，或返回首页。'
        }
        extra={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
            {hasError && (
              <Button icon={<ReloadOutlined />} onClick={() => void navigate(0)}>
                重试
              </Button>
            )}
            <Link to={home}>
              <Button type="primary" icon={<ArrowLeftOutlined />}>
                返回首页
              </Button>
            </Link>
          </div>
        }
      />
    </div>
  );
}

/**
 * 按当前路径猜「本子系统的首页」。
 *
 * 404 / 500 页的「返回首页」要用它 —— 在 `/admin/xxx` 出了错，
 * 回首页应该回 `/admin`（租户后台），而不是 `/`（那会再分流一次）。
 *
 * - `/admin/...`   → `/admin`
 * - `/system/...`  → `/system`
 * - `/customer/...`→ `/customer`
 * - 其它（挂件 / 根路径）→ `/`
 */
export function homePathFor(pathname: string): string {
  const subsystems = ['admin', 'system', 'customer'] as const;
  for (const sub of subsystems) {
    if (pathname === `/${sub}` || pathname.startsWith(`/${sub}/`)) {
      return `/${sub}`;
    }
  }
  return '/';
}
