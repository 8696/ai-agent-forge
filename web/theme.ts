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
 */

const fontFamily = `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', Roboto, 'Helvetica Neue', Arial, sans-serif`;

const sharedToken = {
  colorPrimary: '#2f54eb',
  colorSuccess: '#52c41a',
  colorWarning: '#faad14',
  colorError: '#ff4d4f',
  colorInfo: '#2f54eb',

  colorBgLayout: '#f5f7fa',
  colorBgContainer: '#ffffff',
  colorBgElevated: '#ffffff',
  colorBgSpotlight: '#fafbfc',

  colorBorder: '#f0f0f0',
  colorBorderSecondary: '#f5f5f5',

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

  fontFamily,
  lineHeight: 1.5715,

  wireframe: false,
};

const sharedComponents = {
  Layout: {
    bodyBg: '#f5f7fa',
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
  Modal: {
    borderRadiusLG: 12,
    titleFontSize: 17,
    titleColor: '#1f2937',
    contentBg: '#ffffff',
    headerBg: '#ffffff',
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
  Alert: {
    borderRadiusLG: 8,
    paddingBlock: 10,
    paddingInline: 14,
  },
  Tabs: {
    titleFontSize: 14,
    horizontalItemPadding: '8px 0',
    horizontalItemGutter: 32,
  },
  Upload: {
    borderRadiusLG: 10,
  },
  Empty: {
    colorTextDisabled: 'rgba(0,0,0,0.45)',
  },
  Divider: {
    colorSplit: '#f0f0f0',
  },
  Tooltip: {
    borderRadius: 6,
  },
  Dropdown: {
    paddingBlock: 8,
    zIndexPopup: 1050,
  },
} as const;

export const lightTheme: ThemeConfig = {
  algorithm: antdTheme.defaultAlgorithm,
  token: sharedToken,
  components: sharedComponents,
};

/**
 * 深色主题 —— 算法已挂上；UI 切换按钮本轮不做（spec §0.2
 * "支持深色模式"已满足 = 算法可用 = 后续一键切换）
 */
export const darkTheme: ThemeConfig = {
  algorithm: antdTheme.darkAlgorithm,
  token: sharedToken,
  components: sharedComponents,
};
