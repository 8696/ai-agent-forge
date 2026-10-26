import { test, expect } from '@playwright/test';

/**
 * 登录页的页面级验收 —— docs/04-b-ui-登录与聊天挂件.md §3
 *
 * ⚠️ **这一层跟 tests/integration/auth-*.test.ts 是互补的，不是重复**：
 *    集成测试验的是「后端返回什么」，这里验的是「页面能不能用」——
 *    表单字段名对不对、错误提示出不出来、登录完跳到哪。
 *    这两类问题集成测试**一个都发现不了**。
 *
 * fixture 凭据来自 tests/fixtures/fixtures.json（globalSetup 里 seed 好的）。
 */
/**
 * ⚠️ **antd v6 会给「正好两个汉字」的按钮中间插一个空格** ——
 *    `<Button>登录</Button>` 渲染出来的 textContent 是 **「登 录」**。
 *    所以 `getByRole('button', { name: '登录' })` **匹配不到**，
 *    必须写成正则 `/登\s*录/`（容忍那个空格）。
 *    这是写这层测试最容易踩的一个坑。
 */
const ADMIN = { tenant: 'acme', email: 'admin@acme.test', password: 'AcmeAdmin-123!' };
const CUSTOMER = { tenant: 'acme', email: 'alice@acme.test', password: 'AcmeCustomer-123!' };
const SYSTEM = { email: 'platform-admin@local.test', password: 'PlatformAdmin-123!' };

test.describe('三套登录页', () => {
  test('admin 登录页渲染出三个字段 + 记住我 + 忘记密码留位', async ({ page }) => {
    await page.goto('/admin/login');

    await expect(page.getByRole('heading', { name: '租户后台登录' })).toBeVisible();
    await expect(page.getByText('租户号由你的 SaaS 服务方提供')).toBeVisible();
    await expect(page.getByLabel('租户号')).toBeVisible();
    await expect(page.getByLabel('邮箱')).toBeVisible();
    await expect(page.getByLabel('密码')).toBeVisible();
    await expect(page.getByRole('checkbox', { name: '记住我' })).toBeChecked();
    // 「忘记密码」是 v1 不实现的 UI 留位：灰色禁用 + tooltip
    await expect(page.getByRole('button', { name: '忘记密码？' })).toBeDisabled();
  });

  test('customer 登录页渲染（无租户后台的「记住我」）', async ({ page }) => {
    await page.goto('/customer/login');

    await expect(page.getByRole('heading', { name: '用户登录' })).toBeVisible();
    await expect(page.getByLabel('租户号')).toBeVisible();
    await expect(page.getByLabel('邮箱')).toBeVisible();
    await expect(page.getByLabel('密码')).toBeVisible();
  });

  test('system 登录页只有邮箱 + 密码（平台方不挂租户号）', async ({ page }) => {
    await page.goto('/system/login');

    await expect(page.getByRole('heading', { name: '平台管理登录' })).toBeVisible();
    await expect(page.getByLabel('邮箱')).toBeVisible();
    await expect(page.getByLabel('密码')).toBeVisible();
    await expect(page.getByLabel('租户号')).toHaveCount(0);
  });

  test('密码错 → 提示「邮箱或密码错误」，且**不跳走**', async ({ page }) => {
    await page.goto('/admin/login');
    await page.getByLabel('租户号').fill(ADMIN.tenant);
    await page.getByLabel('邮箱').fill(ADMIN.email);
    await page.getByLabel('密码').fill('WrongPass-123!');
    await page.getByRole('button', { name: /登\s*录/ }).click();

    await expect(page.getByText('邮箱或密码错误')).toBeVisible();
    await expect(page).toHaveURL(/\/admin\/login/);
  });

  test('租户号格式非法 → 表单就地报错，不发请求', async ({ page }) => {
    await page.goto('/admin/login');
    await page.getByLabel('租户号').fill('BAD CODE');
    await page.getByLabel('邮箱').fill(ADMIN.email);
    await page.getByLabel('密码').fill(ADMIN.password);
    await page.getByRole('button', { name: /登\s*录/ }).click();

    // antd 的字段级校验文案（shared/validation/tenant-code.ts 的 TENANT_CODE_HINT）
    await expect(page.getByText('3-32 位，小写字母 / 数字 / 短横线')).toBeVisible();
    await expect(page).toHaveURL(/\/admin\/login/);
  });

  test('admin 登录成功 → 跳到 /admin', async ({ page }) => {
    await page.goto('/admin/login');
    await page.getByLabel('租户号').fill(ADMIN.tenant);
    await page.getByLabel('邮箱').fill(ADMIN.email);
    await page.getByLabel('密码').fill(ADMIN.password);
    await page.getByRole('button', { name: /登\s*录/ }).click();

    await expect(page).toHaveURL(/\/admin\/?$/);
    // 登录后拿到的 token 落在 localStorage（勾了「记住我」）
    const token = await page.evaluate(() => localStorage.getItem('agent_platform_token'));
    expect(token).toBeTruthy();
  });

  test('customer 登录成功 → 跳到 /customer 前台首页', async ({ page }) => {
    await page.goto('/customer/login');
    await page.getByLabel('租户号').fill(CUSTOMER.tenant);
    await page.getByLabel('邮箱').fill(CUSTOMER.email);
    await page.getByLabel('密码').fill(CUSTOMER.password);
    await page.getByRole('button', { name: /登\s*录/ }).click();

    await expect(page).toHaveURL(/\/customer\/?$/);
  });

  test('system 登录成功 → 跳到 /system 平台总览', async ({ page }) => {
    await page.goto('/system/login');
    await page.getByLabel('邮箱').fill(SYSTEM.email);
    await page.getByLabel('密码').fill(SYSTEM.password);
    await page.getByRole('button', { name: /登\s*录/ }).click();

    await expect(page).toHaveURL(/\/system\/?$/);
  });
});
