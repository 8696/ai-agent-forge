import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { Button, Result } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';

/**
 * 404 —— 全屏 Result + 回首页按钮
 */
export function NotFoundPage(): ReactElement {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background:
          'radial-gradient(ellipse at top, #e8efff 0%, #f5f7fa 50%, #f0f2f5 100%)',
        padding: 24,
      }}
    >
      <Result
        status="404"
        title="404"
        subTitle="页面不存在，或已被搬走。"
        extra={
          <Link to="/">
            <Button type="primary" icon={<ArrowLeftOutlined />}>
              回首页
            </Button>
          </Link>
        }
      />
    </div>
  );
}
