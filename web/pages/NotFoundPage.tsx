import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { Button, Result } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import { useThemeMode } from '../lib/themeMode';
import { pageGradient } from '../theme';

/**
 * 404 —— 全屏 Result + 回首页按钮
 */
export function NotFoundPage(): ReactElement {
  // 整页渐变跟深色模式走（写死浅色的话，暗色下 404 页是一片白）
  const mode = useThemeMode();

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
