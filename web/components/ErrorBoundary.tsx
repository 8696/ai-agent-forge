import type { ReactElement, ReactNode } from 'react';
import { Button, Result } from 'antd';
import { ErrorBoundary as ReactErrorBoundary, type FallbackProps } from 'react-error-boundary';

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
    <ReactErrorBoundary
      fallbackRender={({ error, resetErrorBoundary }: FallbackProps) => (
        <Result
          status="error"
          title="页面出错了"
          subTitle={error instanceof Error ? error.message : '发生了未知错误'}
          extra={[
            <Button key="retry" type="primary" onClick={() => resetErrorBoundary()}>
              重试
            </Button>,
            <Button key="home" onClick={() => window.location.assign('/')}>
              回首页
            </Button>,
          ]}
          style={{ paddingTop: 80 }}
        />
      )}
    >
      {children}
    </ReactErrorBoundary>
  );
}
