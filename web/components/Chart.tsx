import type { ReactElement } from 'react';
import ReactECharts from 'echarts-for-react';
import type { EChartsCoreOption } from 'echarts';

/**
 * ECharts 图表封装 —— docs/04-d-ui-系统级与公共组件.md §7
 *
 * ## 为什么要有这一层
 *
 * 规格 §7 列了 `<Chart>`（「ECharts 照本封装」）。2026-10-25 之前**没有这个组件**：
 * 4 个页面各自 `import ReactECharts from 'echarts-for-react'` 然后直接用，
 * 高度、主题、`notMerge` 这些选项各写各的 —— 改一次要改 4 个地方。
 *
 * 现在统一走这里：
 *   - 高度是必填参数（各处本来就不一样，不给默认值免得看漏）
 *   - `notMerge` 恒开 —— 数据点数量变化时不 merge，否则旧折线会残留
 *
 * ⚠️ **图表配色必须走 antd token**（见各页面的 option 构造）——
 *    写死浅色 hex 的话，暗色模式下折线会偏暗看不清。
 */
export interface ChartProps {
  /**
   * ECharts 配置项
   *
   * ⚠️ 用 `EChartsCoreOption`（宽松类型，跟 `echarts-for-react` 自己的签名一致）——
   *    各页面的 option 是对象字面量直接推出来的，`type: 'category'` 会被推成
   *    `string`，用严格的 `EChartsOption` 会全部报类型错。
   */
  option: EChartsCoreOption;
  /** 图表高度（px） */
  height: number;
}

export function Chart({ option, height }: ChartProps): ReactElement {
  return <ReactECharts option={option} style={{ height }} notMerge />;
}
