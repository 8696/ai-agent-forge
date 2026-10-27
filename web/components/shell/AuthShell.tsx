import type { ReactElement, ReactNode } from 'react';
import { Button, Card, Space, Spin, Tooltip, Typography, theme } from 'antd';
import { BrandMark } from './BrandMark';
import { useThemeMode } from '../../lib/themeMode';
import { pageGradient } from '../../theme';

const { Title, Text } = Typography;

interface AuthShellProps {
  /** 角色标识（影响 footer 右侧文案） */
  roleLabel: string;
  /**
   * 主标题 —— 规格 04-b §3.4 统一是「登录到 AI 助手」。
   *
   * 各子系统的身份信息放在**副标题**（`description`）里，
   * 别再各写各的标题（以前是「租户后台登录」/「平台管理登录」/「用户登录」三套）。
   */
  title: string;
  /** 副标题 / 描述 */
  description?: string;
  /** 顶部小标识（角色图标可放这里） */
  badge?: ReactNode;
  /**
   * 「忘记密码？」的 tooltip 文案。
   *
   * ⚠️ **平台方（system）没有「租户管理员」这个角色** ——
   *    默认的「请联系租户管理员重置密码」对它来说是错的，
   *    规格 04-b §3.1 要求的是「没有 SaaS 平台方账号？联系系统部署方」。
   */
  forgotPasswordHint?: string;
  /** 表单下方的补充提示（如「租户号由你的 SaaS 服务方提供」） */
  hint?: string;
  /**
   * 提交中 —— 渲染**全屏加载态** `<Spin size="large" fullscreen />`
   * （docs/04-d §8.3「全屏加载：`<Spin size="large" fullscreen />`」）。
   *
   * ⚠️ 以前三个登录页只有按钮上的 `loading` —— 规格点名的这个形态全库不存在。
   */
  loading?: boolean;
  children: ReactNode;
}

/**
 * 3 个登录页公共外壳 —— 详见 docs/04-b-ui-登录与聊天挂件.md §3
 *
 * 视觉：
 *  - 全屏深浅渐变背景（"高级感"）
 *  - 顶部品牌 + 角色 badge
 *  - 中央毛玻璃卡片（白底，圆角 8 / 阴影 4 —— docs/04-a §1.3）
 *  - 底部 footer（role label）
 */
export function AuthShell(props: AuthShellProps): ReactElement {
  // 整页渐变要跟深色模式走 —— 写死浅色渐变的话，暗色下登录页是一片白
  const mode = useThemeMode();
  // 颜色走 antd token —— 写死浅色的话，深色模式下几乎看不见
  const { token } = theme.useToken();

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
        <Space orientation="vertical" size={10} align="center">
          <BrandMark size="lg" variant={mode === 'dark' ? 'dark' : 'light'} />
          {props.badge !== undefined && props.badge}
        </Space>
      </div>

      {/* 主卡片 */}
      <Card
        style={{
          width: '100%',
          maxWidth: 400, // docs/04-b §3.4「卡片宽度：400px」
          // docs/04-a §1.3「圆角 8、阴影 4」—— 跟 web/theme.ts 的 borderRadius 对齐，
          // 阴影走 antd token（写死 rgba(...) 的话深色模式下那层阴影是死的）
          borderRadius: token.borderRadius,
          boxShadow: token.boxShadowSecondary,
          border: `1px solid ${token.colorFillTertiary}`,
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

        {/* 表单下方的补充提示（规格里那句「租户号由你的 SaaS 服务方提供」之类） */}
        {props.hint !== undefined && (
          <div style={{ textAlign: 'center', marginTop: 14 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {props.hint}
            </Text>
          </div>
        )}

        {/* 「忘记密码」—— v1 不实现，UI 留位（docs/04-b §3.4）。
            灰色禁用 + tooltip 说明为什么不能点，别让用户以为功能坏了。
            ⚠️ 文案按子系统走：平台方没有「租户管理员」，见 forgotPasswordHint。 */}
        <div style={{ textAlign: 'center', marginTop: 18 }}>
          <Tooltip title={props.forgotPasswordHint ?? '请联系租户管理员重置密码'}>
            <Button type="link" size="small" disabled style={{ padding: 0 }}>
              忘记密码？
            </Button>
          </Tooltip>
        </div>
      </Card>

      {/* 底部 */}
      <div
        style={{
          marginTop: 28,
          textAlign: 'center',
          fontSize: 12,
          color: token.colorTextTertiary,
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

      {/* 全屏加载态（docs/04-d §8.3）—— 提交中盖一层 */}
      {props.loading === true && <Spin size="large" fullscreen />}
    </div>
  );
}
