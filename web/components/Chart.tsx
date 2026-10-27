import type { ReactElement } from 'react';
import { useMemo } from 'react';
import { theme } from 'antd';
import type { GlobalToken } from 'antd';
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
 * ## 配色：为什么 token 要在组件内部合进去
 *
 * ECharts 自带的 `light` 主题是**写死**的（`echarts/lib/visual/tokens.js`）：
 * 刻度文字 `neutral70` = `#54555a`、网格线 `neutral15` = `#dbdee4`。
 * 深色模式下卡片底是 `#1f1f1f` —— 刻度文字跟底色只有 **2.22:1** 的对比度（AA 要 4.5:1），
 * 而网格线是浅色的，于是「深底上只看得见网格线、看不见刻度」。
 *
 * ⚠️ **不能指望 ECharts 自己 merge**：`notMerge` 恒开（数据点数量变化时
 * 旧折线会残留），而 `notMerge: true` 的 `setOption` 是**整块替换**，
 * 前一次设进去的默认配色会被清掉。
 *
 * 所以做法是：**在组件内部把 antd token 的颜色合进最终传给 `ReactECharts` 的 option**
 * （`mergeOption(tokenBaseOption(token), props.option)`），调用方显式设置过的优先。
 * 这样深浅色切换时 token 变 → option 变 → 图表重画，不需要各页面各写一遍。
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

/** option 里任意一层的普通对象 */
type Plain = Record<string, unknown>;

function isPlainObject(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 深合并 —— **调用方（override）优先**。
 *
 * - 两边都是对象 → 逐键递归合并
 * - 调用方给的是数组 → **逐项合并**（默认值是对象时，每一项都带上默认值）。
 *   `xAxis` / `yAxis` 经常是数组，只给第一项补色是经典 bug。
 * - 其余情况 → 取调用方的
 */
function mergeOption(base: unknown, override: unknown): unknown {
  if (Array.isArray(override)) {
    return override.map((item, idx) => {
      const prev = Array.isArray(base) ? base[idx] : base;
      return mergeOption(prev, item);
    });
  }
  if (isPlainObject(base) && isPlainObject(override)) {
    const result: Plain = { ...base };
    for (const [key, value] of Object.entries(override)) {
      result[key] = mergeOption(base[key], value);
    }
    return result;
  }
  return override;
}

/**
 * 造一份「antd token 配色」的默认 option。
 *
 * ⚠️ **`xAxis` / `yAxis` 里的默认值只在调用方自己声明了坐标轴时才生效**
 *    —— 见 `buildThemedOption` 里「顶层只补调用方声明过的 key」那条规则。
 */
function tokenBaseOption(token: GlobalToken): Plain {
  /** 坐标轴的通用配色（x / y 一致） */
  const axis = {
    // 刻度文字：深色模式下这是最关键的一处（默认的 #54555a 在深底上不可读）
    axisLabel: { color: token.colorTextSecondary },
    // 轴线：淡一点，别跟刻度文字抢
    axisLine: {
      color: token.colorBorderSecondary,
      lineStyle: { color: token.colorBorderSecondary },
    },
    // 刻度小短线
    axisTick: { lineStyle: { color: token.colorBorderSecondary } },
    // 网格分割线：深色模式下必须变暗（默认是浅色 #dbdee4）
    splitLine: {
      color: token.colorSplit,
      lineStyle: { color: token.colorSplit },
    },
    // 坐标轴名称（yAxis.name 之类）
    nameTextStyle: { color: token.colorTextSecondary },
  };

  return {
    textStyle: { color: token.colorTextSecondary },
    tooltip: {
      backgroundColor: token.colorBgElevated,
      borderColor: token.colorBorderSecondary,
      textStyle: { color: token.colorText },
    },
    legend: {
      textStyle: { color: token.colorTextSecondary },
    },
    xAxis: axis,
    yAxis: axis,
  };
}

/**
 * 把 token 配色合进调用方的 option。
 *
 * ⚠️ **顶层只补「调用方声明过的 key」**（外加 `textStyle`）：
 *    `xAxis` / `legend` / `tooltip` 这些 key 一旦出现在 option 里，
 *    ECharts 就会创建对应的组件 —— 凭空补一个 `legend` 会多出一个空图例，
 *    凭空补一个 `xAxis` 会多出一套坐标系。所以「没声明就不补」。
 */
function buildThemedOption(option: EChartsCoreOption, token: GlobalToken): EChartsCoreOption {
  const src = (option ?? {}) as Plain;
  const base = tokenBaseOption(token);

  const result: Plain = { ...src };
  for (const key of Object.keys(base)) {
    // textStyle 永远带上（它只是样式袋，不会凭空造出组件）
    if (key === 'textStyle') continue;
    if (!(key in src)) continue;
    result[key] = mergeOption(base[key], src[key]);
  }
  result.textStyle = mergeOption(base.textStyle, src.textStyle ?? {});

  return result as EChartsCoreOption;
}

export function Chart({ option, height }: ChartProps): ReactElement {
  const { token } = theme.useToken();
  // token 变（切深浅色）→ option 变 → echarts-for-react 重新 setOption
  const themedOption = useMemo(() => buildThemedOption(option, token), [option, token]);
  return <ReactECharts option={themedOption} style={{ height }} notMerge />;
}
