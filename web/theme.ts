import { theme as antdTheme } from 'antd';
import type { ThemeConfig } from 'antd';

/**
 * AgentForge 全局设计 token
 * 详见 docs/04-a-ui-总则布局与菜单.md §0.2 + §1
 *
 * 选定主色 #2f54eb（AntD 极客蓝）—— 比 v6 默认 #1677ff 沉稳一点，
 * 跟 Layout 深底 + 白内容容器形成更强对比，整体观感更"产品级"。
 *
 * 任何组件级 token 调整在这里集中改；调用方只 import 整个主题对象。
 *
 * ## 深色模式（docs/04-d §9.3）
 *
 * token 分三层：
 *   - `brandToken`  两种模式都一样（主色 / 圆角 / 字号 / 行高）
 *   - `lightToken` / `darkToken`  **随模式变**（背景 / 边框 / 文字色）
 *   - `lightComponents` / `darkComponents`  同上（Table / Modal / Tag 等）
 *
 * ⚠️ 之前把浅色背景写死在一个 token 里，深色算法（darkAlgorithm）拿到的
 *    仍然是白底 —— 那样"切了暗色但还是白底"。背景色必须拆开。
 */

/** 两种模式都一样的部分 */
const brandToken = {
  colorPrimary: '#2f54eb',
  colorSuccess: '#52c41a',
  colorWarning: '#faad14',
  colorError: '#ff4d4f',
  colorInfo: '#2f54eb',

  borderRadius: 8,
  borderRadiusLG: 12,
  borderRadiusSM: 4,

  fontSize: 14,
  fontSizeLG: 16,
  fontSizeXL: 20,
  fontSizeHeading1: 30,
  fontSizeHeading2: 24,
  fontSizeHeading3: 20,
  fontSizeHeading4: 18,
  fontSizeHeading5: 16,

  controlHeight: 36,
  controlHeightLG: 40,
  controlHeightSM: 28,

  fontFamily: `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', Roboto, 'Helvetica Neue', Arial, sans-serif`,
  lineHeight: 1.5715,

  wireframe: false,
};

/** 浅色模式的背景 / 边框 */
const lightToken = {
  ...brandToken,
  colorBgLayout: '#f5f7fa',
  colorBgContainer: '#ffffff',
  colorBgElevated: '#ffffff',
  colorBgSpotlight: '#fafbfc',
  colorBorder: '#f0f0f0',
  colorBorderSecondary: '#f5f5f5',
};

/** 深色模式的背景 / 边框（AntD 深色调色板） */
const darkToken = {
  ...brandToken,
  colorBgLayout: '#141414',
  colorBgContainer: '#1f1f1f',
  colorBgElevated: '#262626',
  colorBgSpotlight: '#333333',
  colorBorder: '#424242',
  colorBorderSecondary: '#303030',
};

/**
 * 两种模式都一样的组件 token。
 * 注意 Menu 的深色项 —— 侧栏本来就是深底的（`theme="dark"`），
 * 亮暗模式切换时它不变。
 */
const sharedComponents: ThemeConfig['components'] = {
  Layout: {
    headerBg: '#001529',
    headerHeight: 56,
    headerPadding: '0 24px',
    headerColor: 'rgba(255,255,255,0.85)',
    siderBg: '#001529',
    triggerBg: 'rgba(255,255,255,0.06)',
    triggerColor: 'rgba(255,255,255,0.85)',
    footerBg: 'transparent',
    footerPadding: '20px 24px',
  },
  Menu: {
    darkItemBg: '#001529',
    darkSubMenuItemBg: '#000c17',
    darkItemSelectedBg: '#2f54eb',
    darkItemHoverBg: 'rgba(255,255,255,0.06)',
    darkItemColor: 'rgba(255,255,255,0.75)',
    darkItemSelectedColor: '#ffffff',
    darkPopupBg: '#001529',
    itemBorderRadius: 6,
    itemMarginInline: 10,
    itemHeight: 40,
    itemPaddingInline: 12,
    iconSize: 16,
  },
  Card: {
    borderRadiusLG: 12,
    paddingLG: 24,
    headerBg: 'transparent',
    headerFontSize: 16,
    headerFontSizeSM: 14,
  },
  Button: {
    borderRadius: 6,
    borderRadiusLG: 8,
    borderRadiusSM: 4,
    controlHeight: 36,
    controlHeightLG: 40,
    controlHeightSM: 28,
    fontWeight: 500,
    primaryShadow: '0 1px 2px rgba(47, 84, 235, 0.15)',
  },
  Drawer: {
    footerPaddingBlock: 16,
    footerPaddingInline: 24,
  },
  Typography: {
    titleMarginTop: 0,
    titleMarginBottom: '0.5em',
    fontWeightStrong: 600,
  },
  Alert: {
    borderRadiusLG: 8,
  },
  Tabs: {
    titleFontSize: 14,
    horizontalItemPadding: '8px 0',
    horizontalItemGutter: 32,
  },
  Upload: {
    borderRadiusLG: 10,
  },
  Input: {
    borderRadius: 6,
    controlHeight: 36,
    controlHeightLG: 40,
    paddingInline: 12,
  },
  Select: {
    borderRadius: 6,
    controlHeight: 36,
    controlHeightLG: 40,
  },
  Form: {
    labelFontSize: 13,
    verticalLabelPadding: '0 0 6px',
    itemMarginBottom: 18,
  },
  Tooltip: {
    borderRadius: 6,
  },
  Dropdown: {
    paddingBlock: 8,
    zIndexPopup: 1050,
  },
};

const lightComponents: ThemeConfig['components'] = {
  ...sharedComponents,
  Layout: { ...sharedComponents?.Layout, bodyBg: '#f5f7fa' },
  Table: {
    headerBg: '#fafbfc',
    headerColor: '#1f2937',
    headerSplitColor: 'transparent',
    rowHoverBg: '#f5f7fa',
    borderColor: '#f0f0f0',
    cellPaddingBlock: 12,
    cellPaddingInline: 16,
    cellFontSize: 14,
    headerSortActiveBg: '#f0f4ff',
    headerSortHoverBg: '#f0f4ff',
  },
  Modal: {
    borderRadiusLG: 12,
    titleFontSize: 17,
    titleColor: '#1f2937',
    contentBg: '#ffffff',
    headerBg: '#ffffff',
  },
  Tag: {
    borderRadiusSM: 4,
    defaultBg: '#fafafa',
    defaultColor: '#595959',
  },
  Breadcrumb: {
    itemColor: '#8c8c8c',
    lastItemColor: '#262626',
    separatorColor: '#bfbfbf',
    fontSize: 13,
  },
  Empty: {
    colorTextDisabled: 'rgba(0,0,0,0.45)',
  },
  Divider: {
    colorSplit: '#f0f0f0',
  },
};

const darkComponents: ThemeConfig['components'] = {
  ...sharedComponents,
  Layout: { ...sharedComponents?.Layout, bodyBg: '#141414' },
  Table: {
    headerBg: '#1f1f1f',
    headerColor: 'rgba(255,255,255,0.85)',
    headerSplitColor: 'transparent',
    rowHoverBg: '#262626',
    borderColor: '#303030',
    cellPaddingBlock: 12,
    cellPaddingInline: 16,
    cellFontSize: 14,
    headerSortActiveBg: '#1f3552',
    headerSortHoverBg: '#1f3552',
  },
  Modal: {
    borderRadiusLG: 12,
    titleFontSize: 17,
    titleColor: 'rgba(255,255,255,0.88)',
    contentBg: '#1f1f1f',
    headerBg: '#1f1f1f',
  },
  Tag: {
    borderRadiusSM: 4,
    defaultBg: '#333333',
    defaultColor: 'rgba(255,255,255,0.88)',
  },
  Breadcrumb: {
    itemColor: 'rgba(255,255,255,0.45)',
    lastItemColor: 'rgba(255,255,255,0.88)',
    separatorColor: 'rgba(255,255,255,0.25)',
    fontSize: 13,
  },
  Empty: {
    colorTextDisabled: 'rgba(255,255,255,0.45)',
  },
  Divider: {
    colorSplit: '#303030',
  },
};

/**
 * 整页渐变背景（登录页 / 404 页 / 挂件底板）。
 *
 * ⚠️ **不能写死一套颜色**：写死的浅色渐变在深色模式下会让整页变成白底 ——
 * 这是 docs/04-d §9.3 明确禁止的（「凡是写死浅色的地方一律换成 token」）。
 *
 * 深色版不是简单反色：浅色版是「蓝调渐变」（顶部 #e8efff 往下褪到中性灰），
 * 深色版对应做成「深蓝 → 近黑」，保持同样的层次感。
 */
export function pageGradient(dark: boolean): string {
  return dark
    ? 'radial-gradient(ellipse at top, #1b2340 0%, #141414 50%, #0d0d0d 100%)'
    : 'radial-gradient(ellipse at top, #e8efff 0%, #f5f7fa 50%, #f0f2f5 100%)';
}

export const lightTheme: ThemeConfig = {
  algorithm: antdTheme.defaultAlgorithm,
  token: lightToken,
  components: lightComponents,
};

export const darkTheme: ThemeConfig = {
  algorithm: antdTheme.darkAlgorithm,
  token: darkToken,
  components: darkComponents,
};
