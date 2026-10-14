import type { CSSProperties, ReactElement } from 'react';
import { Avatar, Space, Typography } from 'antd';
import { RobotOutlined } from '@ant-design/icons';

const { Text } = Typography;

type BrandSize = 'sm' | 'md' | 'lg';

interface BrandMarkProps {
  size?: BrandSize;
  /** 显示文字部分；不传就用 "AgentForge" */
  text?: string;
  /** 主题色版：sider/header 用深色版，登录页用浅色版 */
  variant?: 'dark' | 'light';
  style?: CSSProperties;
}

const SIZE_MAP: Record<
  BrandSize,
  { avatar: number; fontSize: number; gap: number; avatarFontSize: number }
> = {
  sm: { avatar: 28, fontSize: 14, gap: 8, avatarFontSize: 14 },
  md: { avatar: 32, fontSize: 16, gap: 10, avatarFontSize: 16 },
  lg: { avatar: 44, fontSize: 22, gap: 12, avatarFontSize: 22 },
};

/**
 * 品牌 Logo 占位 —— 见 docs/04-a-ui-总则布局与菜单.md §0.2
 * 用 AntD RobotOutlined + 浅蓝渐变背景，**不**引图片资源。
 */
export function BrandMark(props: BrandMarkProps): ReactElement {
  const size = props.size ?? 'md';
  const variant = props.variant ?? 'dark';
  const m = SIZE_MAP[size];

  const textColor = variant === 'dark' ? '#fff' : '#1f2937';

  return (
    <Space size={m.gap} align="center" {...(props.style !== undefined ? { style: props.style } : {})}>
      <Avatar
        size={m.avatar}
        shape="square"
        style={{
          background: 'linear-gradient(135deg, #2f54eb 0%, #597ef7 100%)',
          fontSize: m.avatarFontSize,
        }}
        icon={<RobotOutlined />}
      />
      {props.text !== '' && (
        <Text style={{ color: textColor, fontSize: m.fontSize, fontWeight: 600, letterSpacing: 0.2 }}>
          {props.text ?? 'AgentForge'}
        </Text>
      )}
    </Space>
  );
}
