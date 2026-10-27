import { test, expect } from '@playwright/test';

/**
 * 路由守卫的页面级验收 —— docs/04-d-ui-系统级与公共组件.md §7.1
 *
 * 守卫逻辑收在公共的 `<RequireAuth>` 组件里
 * （`web/components/RequireAuth.tsx`，三套 Layout 共用）。
 * 这里验的是**它真的在浏览器里生效**——
 * 集成测试只能验后端返 401，验不了「前端有没有弹到登录页」。
 *
 * ⚠️ 每个用例都从干净状态开始（没有 token），
 *    所以先清掉两种存储 —— 「记住我」会把 token 放 localStorage，
 *    不勾则放 sessionStorage，两个都得清。
 */
async function clearAuth(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
}

test.describe('路由守卫（未登录 → 弹到本子系统的登录页）', () => {
  test('admin：/admin/users → /admin/login', async ({ page }) => {
    await clearAuth(page);
    await page.goto('/admin/users');
    await expect(page).toHaveURL(/\/admin\/login/);
  });

  test('customer：/customer/chat → /customer/login', async ({ page }) => {
    await clearAuth(page);
    await page.goto('/customer/chat');
    await expect(page).toHaveURL(/\/customer\/login/);
  });

  test('system：/system/tenants → /system/login', async ({ page }) => {
    await clearAuth(page);
    await page.goto('/system/tenants');
    await expect(page).toHaveURL(/\/system\/login/);
  });

  test('根路径 / → 未登录时弹到 /customer/login', async ({ page }) => {
    await clearAuth(page);
    await page.goto('/');
    await expect(page).toHaveURL(/\/customer\/login/);
  });

  test('登录页本身不该被守卫弹走（不能死循环）', async ({ page }) => {
    await clearAuth(page);
    await page.goto('/admin/login');
    await expect(page).toHaveURL(/\/admin\/login/);
    await expect(page.getByRole('heading', { name: '登录到 AI 助手' })).toBeVisible();
  });
});
