import { test, expect } from '@playwright/test';

/**
 * **antd v6 废弃 API 守卫** —— 锁住「控制台不再刷警告」这条交付声明
 *
 * ## 为什么要有这个
 *
 * 2026-10-26 有一批 antd v6 的废弃 API 迁移（`Alert message` → `title`、
 * `Space direction` → `orientation`、`Drawer width` → `size` …），
 * 迁移完当时的结论是「**控制台不再刷警告**」。
 *
 * ⚠️ **但那批迁移漏了 7 处** —— 其中 6 处在租户后台的页面里，
 * 1 处在公开挂件的历史记录抽屉上（`WidgetPage` 的 `Drawer width`）。
 * 为什么没被发现？因为**当时的 e2e 只访问登录页 / 守卫 / 深色模式 / 挂件**，
 * 后台那些页面压根没被打开过 —— 警告只在页面打开时才打。
 *
 * 这个 spec 就是补那个洞：**把每个后台页面都打开一遍，
 * 收集控制台里的 antd 废弃警告，有一条就红。**
 *
 * ## 怎么判定「废弃警告」
 *
 * antd v6 的废弃警告都长这样：
 *   `Warning: [antd: Drawer] \`width\` is deprecated. Please use \`size\` instead.`
 * 我们只认 `[antd: ` 开头的，别的警告（React key 重复、act 警告等）不归它管。
 */
const ANT_DEPRECATION = /\[antd: /;

/** 收集控制台里所有 antd 废弃警告 */
function collectAntWarnings(page: import('@playwright/test').Page): string[] {
  const warnings: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'warning' && msg.type() !== 'error') return;
    const text = msg.text();
    if (ANT_DEPRECATION.test(text)) warnings.push(text);
  });
  return warnings;
}

const ADMIN = { tenant: 'acme', email: 'admin@acme.test', password: 'AcmeAdmin-123!' };
const SYSTEM = { email: 'platform-admin@local.test', password: 'PlatformAdmin-123!' };

/** 租户后台的全部页面（web/routes.tsx 的 /admin 分支） */
const ADMIN_PAGES = [
  '/admin',
  '/admin/users',
  '/admin/memories',
  '/admin/knowledge/documents',
  '/admin/knowledge/test',
  '/admin/models',
  '/admin/prompts',
  '/admin/settings',
  '/admin/observability/traces',
  '/admin/observability/cost',
  '/admin/observability/alerts',
  '/admin/evaluation/datasets',
  '/admin/evaluation/runs',
  '/admin/evaluation/compare',
  '/admin/audit',
  '/admin/api-keys',
  '/admin/tools',
  '/admin/tool-logs',
];

/** 平台方后台的全部页面 */
const SYSTEM_PAGES = ['/system', '/system/tenants', '/system/audit'];

async function loginAsAdmin(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/admin/login');
  await page.getByLabel('租户号').fill(ADMIN.tenant);
  await page.getByLabel('邮箱').fill(ADMIN.email);
  await page.getByLabel('密码').fill(ADMIN.password);
  await page.getByRole('button', { name: /登\s*录/ }).click();
  await page.waitForURL(/\/admin(\/|$)/);
}

async function loginAsSystem(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/system/login');
  await page.getByLabel('邮箱').fill(SYSTEM.email);
  await page.getByLabel('密码').fill(SYSTEM.password);
  await page.getByRole('button', { name: /登\s*录/ }).click();
  await page.waitForURL(/\/system(\/|$)/);
}

test.describe('antd v6 废弃 API', () => {
  test('租户后台的每个页面都不刷 antd 废弃警告', async ({ page }) => {
    const warnings = collectAntWarnings(page);
    await loginAsAdmin(page);

    for (const path of ADMIN_PAGES) {
      await page.goto(path);
      // 等页面把首屏数据拉完（后台页都是数据驱动渲染）
      await page.waitForLoadState('networkidle').catch(() => undefined);
    }

    expect(warnings, '控制台出现了 antd 废弃 API 警告').toEqual([]);
  });

  test('平台方后台的每个页面都不刷 antd 废弃警告', async ({ page }) => {
    const warnings = collectAntWarnings(page);
    await loginAsSystem(page);

    for (const path of SYSTEM_PAGES) {
      await page.goto(path);
      await page.waitForLoadState('networkidle').catch(() => undefined);
    }

    expect(warnings, '控制台出现了 antd 废弃 API 警告').toEqual([]);
  });

  test('公开挂件不刷 antd 废弃警告（含历史记录抽屉的 width → size）', async ({ page }) => {
    const warnings = collectAntWarnings(page);
    await page.goto('/widget/acme');
    await page.waitForLoadState('networkidle').catch(() => undefined);
    expect(warnings, '控制台出现了 antd 废弃 API 警告').toEqual([]);
  });
});
