import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * **e2e 页面清单 ↔ 路由表 的守门**
 *
 * ## 为什么要有这个
 *
 * `tests/e2e/antd-deprecation.spec.ts` 的价值全在「新页面也会被打开」——
 * 废弃警告只在组件渲染时才打，页面没被打开就等于没人守。
 *
 * ⚠️ **2026-10-27 出过一次洞**：加了「切片浏览」页（`/admin/knowledge/chunks`），
 *    但 e2e 的页面清单没同步 → 那个页面上的废弃警告**运行时**没人守，
 *    而静态守卫 `tests/unit/antd-deprecated-props.test.ts` 又只查它自己那张
 *    固定清单（当时清单里没有 `InputNumber.addonAfter`）→ **两层守卫同时漏**，
 *    `ObservabilityAlertsPage` 的 `addonAfter` 废弃警告就这么留在了代码里。
 *
 * 这个测试把「页面清单」和「路由表」绑在一起：
 * **加路由不加进 e2e 清单（或反过来清单里有、路由里没有）→ 测试红。**
 *
 * ## 判定口径
 * - 动态路由（带 `:` 的，如 `/admin/observability/traces/:id`）**不要求**进清单 ——
 *   它们要具体数据才能打开，e2e 里是点进去而不是 goto。
 * - `login` 页**不要求**进清单 —— 登录流程本身就是登录用例的前置步骤。
 * - 清单里多出来的条目不算错（可能有意的补充），但会打出来提醒。
 */
const ROUTES_FILE = path.resolve(__dirname, '../../web/routes.tsx');
const SPEC_FILE = path.resolve(__dirname, '../e2e/antd-deprecation.spec.ts');

const routesSrc = readFileSync(ROUTES_FILE, 'utf8');
const specSrc = readFileSync(SPEC_FILE, 'utf8');

/**
 * 把 routes.tsx 按**顶层**路由块切开。
 *
 * ⚠️ 不能靠 `// ===== ` 注释切 —— 「公开」那一段没有那个注释，
 *    会把 /widget / /dev/probe / 404 全算进 customer。
 *    顶层路由块都是 2 空格缩进的 `{`，按缩进切才准。
 */
function topLevelRouteBlocks(): Array<{ path: string; body: string }> {
  const starts: number[] = [];
  const re = /\n {2}\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(routesSrc)) !== null) starts.push(m.index);

  const out: Array<{ path: string; body: string }> = [];
  for (let i = 0; i < starts.length; i++) {
    const body = routesSrc.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : routesSrc.length);
    const p = /path:\s*'([^']+)'/.exec(body);
    const path = p?.[1];
    if (path !== undefined) out.push({ path, body });
  }
  return out;
}

const ROUTE_BLOCKS = topLevelRouteBlocks();

/** 一个子系统下所有「静态」的完整路径（不含动态段 / login） */
function staticRoutes(prefix: '/admin' | '/system' | '/customer'): string[] {
  const block = ROUTE_BLOCKS.find((b) => b.path === prefix);
  expect(block, `routes.tsx 里找不到 ${prefix} 的路由块`).not.toBeUndefined();
  const out: string[] = [prefix]; // index 路由（子系统首页）
  // 块里第一个 path 是子系统自己，其余是 children
  const childPaths = [...(block?.body.matchAll(/path:\s*'([^']+)'/g) ?? [])]
    .map((x) => x[1])
    .filter((p): p is string => p !== undefined)
    .slice(1);
  for (const child of childPaths) {
    if (child.includes(':')) continue; // 动态路由
    if (child === 'login') continue; // 登录页是登录流程的前置，不单独走
    out.push(`${prefix}/${child}`);
  }
  return out.sort();
}

/** 从 e2e spec 里读出一个页面清单数组 */
function specPages(constName: string): string[] {
  const m = new RegExp(`const ${constName} = \\[([^\\]]*)\\]`).exec(specSrc);
  expect(m, `e2e spec 里找不到 ${constName}`).not.toBeNull();
  const body = m?.[1] ?? '';
  return [...body.matchAll(/'([^']+)'/g)]
    .map((x) => x[1])
    .filter((p): p is string => p !== undefined)
    .sort();
}

describe('e2e 页面清单 ↔ 路由表', () => {
  const cases: Array<[string, string]> = [
    ['ADMIN_PAGES', '/admin'],
    ['SYSTEM_PAGES', '/system'],
    ['CUSTOMER_PAGES', '/customer'],
  ];

  for (const [constName, prefix] of cases) {
    it(`${constName} 覆盖了 ${prefix} 下的每一个静态页面`, () => {
      const expected = staticRoutes(prefix as '/admin' | '/system' | '/customer');
      const actual = specPages(constName);
      const missing = expected.filter((p) => !actual.includes(p));
      expect(
        missing,
        `这些路由没进 e2e 的 ${constName} —— 页面上的废弃警告就没人守了。` +
          `请把 ${missing.join(' / ')} 加进 tests/e2e/antd-deprecation.spec.ts`,
      ).toEqual([]);
    });
  }

  it('清单里没有已经不存在的路由（改路由时别把清单忘了改）', () => {
    const known = [
      ...staticRoutes('/admin'),
      ...staticRoutes('/system'),
      ...staticRoutes('/customer'),
    ];
    const stale = [...specPages('ADMIN_PAGES'), ...specPages('SYSTEM_PAGES'), ...specPages('CUSTOMER_PAGES')].filter(
      (p) => !known.includes(p),
    );
    expect(stale, 'e2e 清单里有路由表里已经不存在的页面').toEqual([]);
  });
});
