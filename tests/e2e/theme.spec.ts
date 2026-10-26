import { test, expect } from '@playwright/test';

/**
 * 深色模式 —— docs/04-d-ui-系统级与公共组件.md §9.3
 *
 * 三件事要在真实浏览器里验（单元测试 / 集成测试都验不了）：
 *  1. 顶栏的 ☀ / 🌙 按钮真的能点
 *  2. `<html data-theme>` 真的跟着变
 *  3. **刷新后仍然是用户选的那个**（localStorage 持久化）
 *
 * 第 3 条是这一层最值得存在的理由 —— 「持久化」这种事在 jsdom 里测是假的。
 */
const ADMIN = { tenant: 'acme', email: 'admin@acme.test', password: 'AcmeAdmin-123!' };

/** antd v6 给两个汉字的按钮中间插空格 —— 「登录」渲染成「登 录」 */
const LOGIN_BTN = /登\s*录/;

async function loginAsAdmin(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/admin/login');
  await page.getByLabel('租户号').fill(ADMIN.tenant);
  await page.getByLabel('邮箱').fill(ADMIN.email);
  await page.getByLabel('密码').fill(ADMIN.password);
  await page.getByRole('button', { name: /登\s*录/ }).click();
  await expect(page).toHaveURL(/\/admin\/?$/);
}

const currentTheme = (page: import('@playwright/test').Page): Promise<string | null> =>
  page.evaluate(() => document.documentElement.getAttribute('data-theme'));

test.describe('深色模式', () => {
  test('点顶栏按钮能切换 data-theme', async ({ page }) => {
    await page.goto('/admin/login');
    await page.getByLabel('租户号').fill(ADMIN.tenant);
    await page.getByLabel('邮箱').fill(ADMIN.email);
    await page.getByLabel('密码').fill(ADMIN.password);
    await page.getByRole('button', { name: /登\s*录/ }).click();
    await expect(page).toHaveURL(/\/admin\/?$/);

    const before = await currentTheme(page);
    expect(before === 'dark' || before === 'light').toBe(true);

    // 按钮的 aria-label 随模式变：「切换到深色模式」/「切换到浅色模式」
    const toggle = page.getByRole('button', { name: /切换到(深色|浅色)模式/ });
    await expect(toggle).toBeVisible();
    await toggle.click();

    const after = await currentTheme(page);
    expect(after).not.toBe(before);
  });

  test('切换后刷新仍然是用户选的那个（localStorage 持久化）', async ({ page }) => {
    await loginAsAdmin(page);

    const before = await currentTheme(page);
    await page.getByRole('button', { name: /切换到(深色|浅色)模式/ }).click();
    const chosen = await currentTheme(page);
    expect(chosen).not.toBe(before);

    await page.reload();
    await expect
      .poll(async () => currentTheme(page))
      .toBe(chosen);

    // 存的值确实在 localStorage 里，键名是 agentforge:theme-mode
    const stored = await page.evaluate(() => localStorage.getItem('agentforge:theme-mode'));
    expect(stored).toBe(chosen);
  });

  test('没存过时跟随系统 prefers-color-scheme', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/admin/login');
    await page.evaluate(() => {
      localStorage.removeItem('agentforge:theme-mode');
    });
    await page.reload();
    await expect.poll(async () => currentTheme(page)).toBe('dark');

    await page.emulateMedia({ colorScheme: 'light' });
    await page.reload();
    await expect.poll(async () => currentTheme(page)).toBe('light');
  });
});
