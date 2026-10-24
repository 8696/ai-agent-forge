import type { ReactElement, ReactNode } from 'react';
import { Empty, theme } from 'antd';

interface EmptyStateProps {
  title?: ReactNode;
  description?: ReactNode;
  /** 跳转 / 重新加载 等操作按钮 */
  action?: ReactNode;
}

/**
 * 统一空态 —— 取代散乱的 <Empty>
 */
export function EmptyState(props: EmptyStateProps): ReactElement {
  const { token } = theme.useToken();
  return (
    <Empty
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      description={
        <div style={{ color: token.colorTextQuaternary, fontSize: 13 }}>
          {props.title !== undefined ? (
            <div style={{ color: token.colorText, fontSize: 14, fontWeight: 500, marginBottom: 4 }}>
              {props.title}
            </div>
          ) : null}
          {props.description}
        </div>
      }
    >
      {props.action}
    </Empty>
  );
}
