import { defineConfig } from 'vitest/config';

/**
 * vitest 配置 —— docs/16-d §D6 测试基建契约
 *
 * 设计意图（强制约定）：
 *  - 只跑 tests 目录下所有 .test.ts 文件（vitest 标准约定）
 *  - tests/integration/ 里老的 standalone 脚本（test-stepN.ts / test-f1.ts）
 *    不在这里跑 —— 它们自己用 tsx 跑；新写的集成测试必须用 .test.ts + vitest
 *  - globalSetup：跑测试前自动 yarn seed 等价的 fixture seed
 *  - testTimeout：60s（LLM 调用 + SSE 流式可能要等）
 *  - 不跑 web/ 下的前端代码（前端测试未来用 Playwright，放 tests/e2e/）
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    globals: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // 单 worker 顺序跑：避免多个测试同时 seed 互相覆盖
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    // 全局前置：跑任何测试前自动 seed + login
    globalSetup: ['./tests/setup.ts'],
  },
});
