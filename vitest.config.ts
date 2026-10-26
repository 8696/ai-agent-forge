import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * vitest 配置 —— docs/12-d §D6 测试基建契约
 *
 * 设计意图（强制约定）：
 *  - 只跑 tests 目录下所有 .test.ts 文件（vitest 标准约定）
 *  - tests/integration/ 里老的 standalone 脚本（test-stepN.ts / test-f1.ts）
 *    不在这里跑 —— 它们自己用 tsx 跑；新写的集成测试必须用 .test.ts + vitest
 *  - globalSetup：跑测试前自动 yarn seed 等价的 fixture seed
 *  - testTimeout：60s（LLM 调用 + SSE 流式可能要等）
 *  - **页面级**的前端验收用 Playwright（放 tests/e2e/）；
 *    但**组件级**的渲染断言（比如 Markdown 的代码块高亮）走 vitest，
 *    所以 include 里带了 `.test.tsx` —— 它 import 的是 web/ 下的组件，
 *    不等于「跑前端应用」
 */
export default defineConfig({
  test: {
    // `.test.tsx` 是前端的**组件级**单元测试（渲染断言，比如 Markdown 的代码块高亮）。
    // 页面级的端到端验收仍然走 Playwright（tests/e2e/）—— 见下方注释。
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: ['node_modules/**', 'dist/**'],
    globals: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // 全局前置：跑任何测试前自动 seed + login
    globalSetup: ['./tests/setup.ts'],
    // 测试进程强制注入 env —— 让 src/config.ts 的 NODE_ENV=test 分支生效，
    // 这样后端 + 测试都默认跑在 3099，不会跟 dev/prod 的 3000 冲突
    env: { NODE_ENV: 'test', PORT: '3099' },
    //
    // ⚠️ **必须关掉文件级并行**：多个测试文件共享同一个 MySQL + 同一个后端进程，
    //    并行跑会互相踩状态（改密码 / 建会话 / 改租户启停互相打架），
    //    表现为随机失败 —— 跟被测代码无关，是测试之间串扰。
    //
    //    ⚠️ vitest 5 **已经移除了 `poolOptions.forks.singleFork`**：
    //    写在那里会被静默忽略（不报错、也不生效），串扰就是这么来的。
    //    替代品是 `fileParallelism: false`（写在 test 里，实测只有这里生效）。
    fileParallelism: false,
  },
  // vitest 5 起 pool / poolOptions 提到顶层（之前嵌在 test 下，DEPRECATED 警告）
  pool: 'forks',
  // 路径别名要跟 tsconfig.json 的 paths 对齐 —— vite/vitest 不读 tsconfig 的 paths，
  // 不显式配的话 `@shared/xxx` 在测试里会解析失败（源码里 tsx 能解析，vitest 不能）
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@shared': path.resolve(__dirname, 'shared'),
    },
  },
});
