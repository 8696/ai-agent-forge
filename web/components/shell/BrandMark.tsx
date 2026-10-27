import type { CSSProperties, ReactElement } from 'react';
import { Avatar, Space, Typography, theme } from 'antd';
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
 * 用 AntD RobotOutlined + 蓝色渐变背景，**不**引图片资源。
 *
 * ⚠️ **形状是 circle**（规格 §0.2 的图标替代表里写的是
 *    `<Avatar shape="circle" ...>`）—— 以前是 square。
 * ⚠️ **颜色全部走 antd token** —— 写死 hex 的话换主题 / 切深色就跟不上。
 */
export function BrandMark(props: BrandMarkProps): ReactElement {
  const size = props.size ?? 'md';
  const variant = props.variant ?? 'dark';
  const m = SIZE_MAP[size];
  // 颜色走 antd token —— 写死浅色的话，深色模式下几乎看不见
  const { token } = theme.useToken();

  // variant=dark = 放在深底上（侧栏 / 顶栏 / 深色登录页）→ 亮字
  // variant=light = 放在浅底上（浅色登录页）→ 跟主题走
  const textColor = variant === 'dark' ? token.colorTextLightSolid : token.colorText;

  return (
    <Space size={m.gap} align="center" {...(props.style !== undefined ? { style: props.style } : {})}>
      <Avatar
        size={m.avatar}
        shape="circle"
        style={{
          background: `linear-gradient(135deg, ${token.colorPrimary} 0%, ${token.colorPrimaryHover} 100%)`,
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
