import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * **antd v6 废弃 API 的静态守卫**
 *
 * ## 为什么要有这个
 *
 * 2026-10-26 有一批 antd v6 废弃 API 迁移（`Alert message` → `title`、
 * `Space direction` → `orientation`、`Drawer width` → `size` …），
 * 当时的结论是「**控制台不再刷警告**」。
 *
 * ⚠️ **但那批迁移漏了 8 处** —— 全在后台页面和挂件抽屉里。
 * 为什么没人发现？因为**当时的 e2e 只访问登录页 / 守卫 / 深色模式 / 挂件**，
 * 后台页面压根没被打开过 —— 警告只在组件渲染时才打。
 *
 * ## 静态扫描 vs 运行时 e2e
 *
 * 两层都有，缺一不可：
 *  - **本测试（静态）**：扫源码，**组件在不在页面上、抽屉开没开都算** ——
 *    「藏在没打开的抽屉里的 Alert」这种运行时扫不到，静态能扫到
 *  - `tests/e2e/antd-deprecation.spec.ts`（运行时）：真开浏览器跑，
 *    抓的是**静态清单没覆盖到的**新废弃项
 *
 * ## 清单是怎么来的
 *
 * 下面这张表 = **antd v6.6.6 里真正会在运行时 `devWarning` 报废弃的属性**
 * （不是类型层的软废弃 —— 比如 `Card bordered` 那种只是类型上标了，
 * 运行时不打警告，就不该拦着人用）。
 *
 * ⚠️ **antd 升级后要核对这张表**：每个测试都会去 antd 的源码里确认
 * 「这个属性确实还在废弃列表里」—— 万一 antd 把它取消了，这个测试会红，
 * 提醒你把清单里那一行删掉（而不是留一条永远绿的假规则）。
 */

/** 组件 → antd v6 运行时真的会告警的废弃属性 */
const DEPRECATED_PROPS: Record<string, string[]> = {
  Alert: ['message', 'closeText'],
  Card: ['headStyle', 'bodyStyle', 'bordered'],
  Collapse: ['destroyInactivePanel', 'expandIconPosition'],
  Descriptions: ['labelStyle', 'contentStyle'],
  Drawer: [
    'headerStyle',
    'bodyStyle',
    'footerStyle',
    'contentWrapperStyle',
    'maskStyle',
    'drawerStyle',
    'destroyOnClose',
    'width',
    'height',
  ],
  Input: ['addonAfter', 'addonBefore'],
  InputNumber: ['addonAfter', 'addonBefore'],
  Modal: [
    'bodyStyle',
    'maskStyle',
    'destroyOnClose',
    'autoFocusButton',
    'focusTriggerAfterClose',
    'maskClosable',
  ],
  Progress: ['width', 'trailColor', 'gapPosition'],
  Space: ['direction', 'split'],
  Statistic: ['valueStyle'],
  Table: ['filterDropdownOpen', 'onFilterDropdownOpenChange'],
  Tabs: ['tabPosition'],
  Timeline: ['label', 'children', 'dot', 'position'],
  Tooltip: ['overlayStyle', 'overlayInnerStyle', 'overlayClassName', 'destroyTooltipOnHide'],
  Transfer: ['listStyle', 'operationStyle', 'operations'],
};

const WEB_DIR = path.resolve(__dirname, '../../web');
const ANTD_LIB = path.resolve(__dirname, '../../node_modules/antd/lib');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/**
 * 取一个 JSX 开标签的完整文本。
 *
 * ⚠️ **不能简单按第一个 `>` 截断** —— 属性值里的箭头函数
 * （`onOk={() => ...}`）自带 `>`，会在中间截断，把后面的属性漏掉。
 * 所以要跟踪花括号深度。
 */
function openingTag(src: string, start: number): string | null {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '>' && depth === 0) return src.slice(start, i + 1);
    else if (ch === '/' && src[i + 1] === '>' && depth === 0) return src.slice(start, i + 2);
  }
  return null;
}

describe('antd v6 废弃 API · 静态扫描', () => {
  it('web/ 里没有 antd 运行时废弃属性的用法', () => {
    const violations: string[] = [];

    for (const file of walk(WEB_DIR)) {
      const src = readFileSync(file, 'utf8');
      const rel = path.relative(WEB_DIR, file);

      for (const [component, props] of Object.entries(DEPRECATED_PROPS)) {
        const re = new RegExp(`<${component}(\\s|>|/)`, 'g');
        let m: RegExpExecArray | null;
        while ((m = re.exec(src)) !== null) {
          const tag = openingTag(src, m.index);
          if (tag === null) continue;
          for (const prop of props) {
            if (new RegExp(`\\b${prop}\\s*=`).test(tag)) {
              const line = src.slice(0, m.index).split('\n').length;
              violations.push(
                `${rel}:${line}  <${component}> 用了废弃属性 ${prop}` +
                  `（antd v6 会打控制台警告）`,
              );
            }
          }
        }
      }
    }

    expect(
      violations,
      'web/ 里还有 antd v6 的废弃属性 —— 改用新的属性名（见 antd 的 @deprecated 注释）',
    ).toEqual([]);
  });

  it('清单里的每一项在当前装的 antd 里确实还是废弃的', () => {
    // antd 的运行时废弃清单长这样：
    //   [['width', 'size'], ['destroyOnClose', 'destroyOnHidden']].forEach(...)
    const sources: string[] = [];
    const walkAntd = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) {
          if (name !== 'style') walkAntd(p);
        } else if (name.endsWith('.js')) {
          sources.push(readFileSync(p, 'utf8'));
        }
      }
    };
    walkAntd(ANTD_LIB);
    const all = sources.join('\n');

    const stale: string[] = [];
    for (const [component, props] of Object.entries(DEPRECATED_PROPS)) {
      for (const prop of props) {
        const stillDeprecated = new RegExp(`\\['${prop}'\\s*,\\s*'`).test(all);
        if (!stillDeprecated) stale.push(`${component}.${prop}`);
      }
    }

    expect(
      stale,
      'antd 里这些属性已经不废弃了 —— 把它们从 DEPRECATED_PROPS 里删掉',
    ).toEqual([]);
  });
});
