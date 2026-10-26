import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright 配置 —— 页面级端到端验收（docs/12-d §D6 测试基建契约的 e2e 层）
 *
 * ## 为什么要单独一层
 *
 * vitest 跑的是 **API 级**验收（tests/integration/*.test.ts）——
 * 它能验「后端行为对不对」，但**验不了「页面点下去对不对」**：
 * 表单字段名改了、路由跳错了、按钮点不动，这些 vitest 一个都发现不了。
 *
 * 这一层用真实浏览器跑真实页面，覆盖三件 vitest 覆盖不到的事：
 *  1. 路由守卫真的会跳（未登录访问受保护页 → 被弹到对应子系统的登录页）
 *  2. 表单真的能填能交（antd Form 的 label / id 绑定对不对）
 *  3. 深色模式真的切换并持久化（`html[data-theme]` + localStorage）
 *
 * ## 跑法
 *
 *   yarn test:e2e            # 自动起后端(3099) + 前端(5173)，跑完关掉
 *   yarn test:e2e --headed   # 想看着它点
 *   yarn test:e2e auth       # 只跑文件名含 "auth" 的那条
 *
 * ⚠️ **跟 vitest 用同一个数据库**（.env 里那个）——
 *    globalSetup 会先 seed 一份 fixture（幂等），跑完不清理。
 *    所以别拿生产库跑这个。
 *
 * ⚠️ **端口**：后端 3099（NODE_ENV=test 的默认端口）、前端 5173（vite 默认）。
 *    两边都开了 `reuseExistingServer` —— 本地已经手动起过服务时不会重复起。
 */
const BACKEND_PORT = Number(process.env.E2E_BACKEND_PORT ?? 3099);
const FRONTEND_PORT = Number(process.env.E2E_FRONTEND_PORT ?? 5173);

export default defineConfig({
  testDir: './tests/e2e',
  // ⚠️ **单 worker**：这些用例共用一个数据库 + 一套 fixture，
  //    并行跑会互相踩状态（跟 vitest 的 fileParallelism: false 同一个理由）。
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: `http://localhost:${FRONTEND_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  // 跑测试前先把 fixture seed 好（system + 2 租户 + admin + customer + API key）
  globalSetup: './tests/e2e/global-setup.ts',

  webServer: [
    {
      // 后端（test 端口 3099）。命令里先跑迁移 —— 新克隆的库没迁移过会起不来。
      command: 'yarn e2e:server',
      url: `http://localhost:${BACKEND_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { NODE_ENV: 'test', PORT: String(BACKEND_PORT) },
    },
    {
      // 前端（vite dev server）。VITE_API_TARGET 把 /api 代理到上面的 3099。
      command: 'yarn dev:frontend',
      url: `http://localhost:${FRONTEND_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { VITE_API_TARGET: `http://localhost:${BACKEND_PORT}` },
    },
  ],
});
