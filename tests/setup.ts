/**
 * vitest globalSetup —— docs/12-d §D6 测试基建契约
 *
 * 跑任何 vitest 测试前自动执行：
 *   1. seedFixtures()   幂等 seed 测试 fixture（system + 2 租户 + admin + customer + API key）
 *   2. login-all         走完 5 个 /login 拿 JWT，写 .e2e-tokens.json
 *
 * 这样 vitest 写的 .test.ts 不用每次都手动 yarn seed + yarn e2e:login。
 * 单独的 Step 验收脚本（test-stepN.ts / test-f1.ts）依然需要 `yarn test:fixtures`。
 */
import 'reflect-metadata';
import { spawnSync } from 'node:child_process';

export async function setup(): Promise<void> {
  const cwd = process.cwd();
  console.log('\n=== [vitest globalSetup] 准备测试 fixture ===\n');

  const seed = spawnSync('yarn', ['seed'], { cwd, stdio: 'inherit' });
  if (seed.status !== 0) throw new Error('yarn seed 失败（见上方输出）');

  const login = spawnSync('yarn', ['e2e:login'], { cwd, stdio: 'inherit' });
  if (login.status !== 0) throw new Error('yarn e2e:login 失败（见上方输出）');

  console.log('\n=== [vitest globalSetup] fixture 就绪 ===\n');
}

export async function teardown(): Promise<void> {
  // 故意不清理：开发者重启测试时复用同一份 fixture 更快
  // 想清就单独跑 destroyFixtures()
}
