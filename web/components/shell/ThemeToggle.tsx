import type { ReactElement } from 'react';
import { BulbOutlined, MoonOutlined } from '@ant-design/icons';
import { toggleThemeMode, useThemeMode } from '../../lib/themeMode';

/**
 * 顶栏右上角的深色模式开关 —— docs/04-d-ui-系统级与公共组件.md §9.3
 *
 * 样式跟顶栏里其它图标按钮一致（透明底 + 白色图标）：
 * 顶栏本身是深色的（headerBg #001529），两种模式下都一样。
 */
export function ThemeToggle(): ReactElement {
  const mode = useThemeMode();
  const isDark = mode === 'dark';

  return (
    <button
      type="button"
      onClick={toggleThemeMode}
      aria-label={isDark ? '切换到浅色模式' : '切换到深色模式'}
      title={isDark ? '切换到浅色模式' : '切换到深色模式'}
      style={{
        background: 'transparent',
        border: 'none',
        color: 'rgba(255,255,255,0.85)',
        cursor: 'pointer',
        padding: 8,
        borderRadius: 6,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 16,
      }}
    >
      {isDark ? <BulbOutlined /> : <MoonOutlined />}
    </button>
  );
}
