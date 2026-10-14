import type { ReactElement, ReactNode } from 'react';
import { Empty } from 'antd';

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
  return (
    <Empty
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      description={
        <div style={{ color: 'rgba(0,0,0,0.45)', fontSize: 13 }}>
          {props.title !== undefined ? (
            <div style={{ color: '#262626', fontSize: 14, fontWeight: 500, marginBottom: 4 }}>
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
