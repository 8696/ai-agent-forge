import { test, expect } from '@playwright/test';

/**
 * 公开挂件 + 404 页 —— docs/12-e-需求-业务接入与平台运营.md §E1
 *
 * 挂件是**唯一免登录**的页面，所以它要单独验：
 *  - 匿名打开就能看到界面（不需要任何 token）
 *  - 租户号写错时给的是「这个租户没有服务」而不是 500
 */
test.describe('公开挂件 /widget/:tenantCode', () => {
  test('匿名打开能看到聊天界面 + 租户名', async ({ page }) => {
    await page.goto('/widget/acme');

    // 页头是「{租户名} 客服」（拿不到租户名时兜底成「在线客服」）
    // ⚠️ 租户名是 seed 写进去的（带 " (Test)" 后缀），所以只断言后缀，别写死全名
    await expect(page.getByText(/客服$/)).toBeVisible();
    await expect(page.getByPlaceholder('问点什么…（Enter 发送，Shift+Enter 换行）')).toBeVisible();
    // ⚠️ antd v6 给两个汉字的按钮中间插空格 —— 「发送」渲染成「发 送」
    await expect(page.getByRole('button', { name: /发\s*送/ })).toBeVisible();
  });

  test('挂件不跳登录页（匿名可访问）', async ({ page }) => {
    await page.goto('/widget/acme');
    await expect(page).toHaveURL(/\/widget\/acme/);
    await expect(page).not.toHaveURL(/login/);
  });

  test('租户号不存在 → 给出「客服不可用」的提示，不是白屏', async ({ page }) => {
    await page.goto('/widget/no-such-tenant-xyz');
    // 拿不到租户信息 → 渲染错误态的 Alert（title = 「客服不可用」）
    await expect(page.getByText('客服不可用')).toBeVisible();
    // 描述里带后端给的错误（"租户 not found" / "HTTP 404" 都可能，随后端改法变）
    await expect(page.locator('.ant-alert-description')).toBeVisible();
  });
});

test.describe('404 页', () => {
  test('不存在的路由 → 404 页 + 回首页的按钮', async ({ page }) => {
    await page.goto('/this-route-does-not-exist');
    await expect(page.getByText('404')).toBeVisible();
    await expect(page.getByText('页面不存在，或已被搬走。')).toBeVisible();
    await expect(page.getByRole('button', { name: '回首页' })).toBeVisible();
  });
});
