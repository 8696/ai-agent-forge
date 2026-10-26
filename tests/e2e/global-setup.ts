/**
 * Playwright globalSetup —— 跑 e2e 之前把 fixture 准备好
 *
 * 与 vitest 的 `tests/setup.ts` 做同一件事（幂等 seed + 登录拿 JWT），
 * 但**分开写**而不是 import 复用：
 * vitest 的 globalSetup 签名是 `export function setup()`，
 * playwright 要的是 **default export**，两者不通用。
 * 底层命令（`yarn seed` / `yarn e2e:login`）是同一套，所以数据完全一致。
 */
import { spawnSync } from 'node:child_process';

export default async function globalSetup(): Promise<void> {
  const cwd = process.cwd();
  console.log('\n=== [playwright globalSetup] 准备测试 fixture ===\n');

  const seed = spawnSync('yarn', ['seed'], { cwd, stdio: 'inherit' });
  if (seed.status !== 0) {
    throw new Error('yarn seed 失败（见上方输出）');
  }

  const login = spawnSync('yarn', ['e2e:login'], { cwd, stdio: 'inherit' });
  if (login.status !== 0) {
    throw new Error('yarn e2e:login 失败（见上方输出）');
  }

  console.log('\n=== [playwright globalSetup] fixture 就绪 ===\n');
}
