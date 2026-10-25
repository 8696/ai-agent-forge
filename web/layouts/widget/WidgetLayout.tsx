import type { ReactElement, ReactNode } from 'react';
import { Button, Tooltip, theme } from 'antd';
import { CustomerServiceOutlined } from '@ant-design/icons';

/**
 * 公开挂件的布局 —— docs/04-a-ui-总则布局与菜单.md §1.2
 *
 * ⚠️ 2026-10-25 从 `WidgetPage.tsx` 里抽出来：规格 §1.2 要求挂件有自己的
 *    `<WidgetLayout />`，以前那段布局代码内联在页面里。
 *
 * 两种形态：
 *   - `WidgetLayout`  —— 展开态：居中的圆角卡片（聊天区）
 *   - `WidgetCollapsed` —— 收起态：右下角一个悬浮圆钮
 *
 * 两个组件都**不套后台外壳**（挂件是要嵌到客户网站里的，不能带侧栏 / 顶栏）。
 */
export function WidgetLayout({ children }: { children: ReactNode }): ReactElement {
  const { token } = theme.useToken();
  return (
    <div
      style={{
        minHeight: '100vh',
        background: token.colorBgLayout,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 760,
          height: 'min(720px, calc(100vh - 48px))',
          display: 'flex',
          flexDirection: 'column',
          background: token.colorBgContainer,
          borderRadius: 12,
          boxShadow: '0 10px 40px rgba(0, 0, 0, 0.12)',
          overflow: 'hidden',
        }}
      >
        {children}
      </div>
    </div>
  );
}

/** 收起态：右下角一个悬浮圆钮（点开挂件） */
export function WidgetCollapsed({ onOpen }: { onOpen: () => void }): ReactElement {
  const { token } = theme.useToken();
  return (
    <div style={{ minHeight: '100vh', background: token.colorBgLayout }}>
      <Tooltip title="打开在线客服" placement="left">
        <Button
          type="primary"
          shape="circle"
          size="large"
          icon={<CustomerServiceOutlined />}
          onClick={onOpen}
          style={{ position: 'fixed', right: 24, bottom: 24, width: 56, height: 56 }}
        />
      </Tooltip>
    </div>
  );
}
