import type { ReactElement, ReactNode } from 'react';
import { Card, Space, Typography } from 'antd';
import { BrandMark } from './BrandMark';
import { useThemeMode } from '../../lib/themeMode';
import { pageGradient } from '../../theme';

const { Title, Text } = Typography;

interface AuthShellProps {
  /** 角色标识（影响 footer 右侧文案） */
  roleLabel: string;
  /** 主标题 */
  title: string;
  /** 副标题 / 描述 */
  description?: string;
  /** 顶部小标识（角色图标可放这里） */
  badge?: ReactNode;
  children: ReactNode;
}

/**
 * 3 个登录页公共外壳 —— 详见 docs/04-b-ui-登录与聊天挂件.md §3
 *
 * 视觉：
 *  - 全屏深浅渐变背景（"高级感"）
 *  - 顶部品牌 + 角色 badge
 *  - 中央毛玻璃卡片（白底，圆角 12）
 *  - 底部 footer（active models + role label）
 */
export function AuthShell(props: AuthShellProps): ReactElement {
  // 整页渐变要跟深色模式走 —— 写死浅色渐变的话，暗色下登录页是一片白
  const mode = useThemeMode();

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '40px 16px',
        background: pageGradient(mode === 'dark'),
      }}
    >
      {/* 顶部品牌 */}
      <div style={{ marginBottom: 28, textAlign: 'center' }}>
        <Space direction="vertical" size={10} align="center">
          <BrandMark size="lg" variant={mode === 'dark' ? 'dark' : 'light'} />
          {props.badge !== undefined && props.badge}
        </Space>
      </div>

      {/* 主卡片 */}
      <Card
        style={{
          width: '100%',
          maxWidth: 420,
          borderRadius: 12,
          boxShadow:
            '0 12px 32px rgba(15, 23, 42, 0.08), 0 2px 6px rgba(15, 23, 42, 0.04)',
          border: '1px solid rgba(0,0,0,0.04)',
        }}
        styles={{ body: { padding: '32px 28px' } }}
      >
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <Title level={2} style={{ marginBottom: 6, fontSize: 22, fontWeight: 600 }}>
            {props.title}
          </Title>
          {props.description !== undefined && (
            <Text type="secondary" style={{ fontSize: 13 }}>
              {props.description}
            </Text>
          )}
        </div>
        {props.children}
      </Card>

      {/* 底部 */}
      <div
        style={{
          marginTop: 28,
          textAlign: 'center',
          fontSize: 12,
          color: 'rgba(0,0,0,0.45)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <Text type="secondary" style={{ fontSize: 12 }}>
          {props.roleLabel}
        </Text>
        {/* ⚠️ 这里**不**挂 ActiveModelsFooter —— 按 docs/04-d §7.4，
            激活模型展示放在三套 Layout 的页脚，登录页不展示 */}
      </div>
    </div>
  );
}
