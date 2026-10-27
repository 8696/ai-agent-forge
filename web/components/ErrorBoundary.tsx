import type { ReactElement, ReactNode } from 'react';
import { useEffect } from 'react';
import { Button, ConfigProvider, Result } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { ErrorBoundary as ReactErrorBoundary, type FallbackProps } from 'react-error-boundary';
import { useThemeMode } from '../lib/themeMode';
import { darkTheme, lightTheme, pageGradient } from '../theme';
import { homePathFor } from '../pages/ErrorPage';

/**
 * 全局错误边界 —— docs/04-d §7 公共组件 / §11.3「错误边界兜底（白屏防护）」
 *
 * ⚠️ **React 渲染时抛出的异常不会被 try/catch 接住** ——
 *    组件渲染到一半炸了，整棵 React 树会卸载，页面直接白屏。
 *    错误边界是唯一能在这种情况下兜住的机制。
 *
 * 兜住之后给用户：一句人话 + 「重试」和「回首页」两个出口，
 * 而不是把堆栈糊在屏幕上（也不要把内部错误细节漏出去）。
 */
interface ErrorBoundaryProps {
  children: ReactNode;
}

export function ErrorBoundary({ children }: ErrorBoundaryProps): ReactElement {
  return (
    <ReactErrorBoundary fallbackRender={(props: FallbackProps) => <ErrorFallback {...props} />}>
      {children}
    </ReactErrorBoundary>
  );
}

/**
 * 兜底 UI —— **全屏居中**（跟 404 / 500 页一个风格，docs/04-a §1.3）。
 *
 * ⚠️ **细节只进控制台，不往屏幕上贴**：
 *    以前这里直接渲染 `error.message` —— 那是内部错误细节（可能带表名、
 *    路径、SQL 片段），跟同一文件里「不要把内部错误细节漏出去」的注释自相矛盾。
 *
 * ⚠️ **自带一层 ConfigProvider**：错误边界挂在 `web/main.tsx` 的**最外层**，
 *    在 App 的 ConfigProvider **外面** —— 不自己包一层的话，
 *    深色模式下这个兜底页会用 AntD 的**浅色**默认主题（深底深字，看不清）。
 */
function ErrorFallback({ error, resetErrorBoundary }: FallbackProps): ReactElement {
  const mode = useThemeMode();

  useEffect(() => {
    // 细节只进控制台
    console.error('[ErrorBoundary] 渲染异常：', error);
  }, [error]);

  return (
    <ConfigProvider locale={zhCN} theme={mode === 'dark' ? darkTheme : lightTheme}>
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
          status="error"
          title="页面出错了"
          subTitle="页面渲染时发生了异常，请重试或返回首页。"
          extra={[
            <Button key="retry" type="primary" onClick={() => resetErrorBoundary()}>
              重试
            </Button>,
            <Button
              key="home"
              onClick={() => window.location.assign(homePathFor(window.location.pathname))}
            >
              回首页
            </Button>,
          ]}
        />
      </div>
    </ConfigProvider>
  );
}
