/**
 * vitest 烟雾测试 —— docs/16-d §D6 测试基建契约
 *
 * 验证 scripts/_lib 全套（fixtures + auth + http）可用。
 * 用 vitest 标准 describe/it/expect 写，是新写的集成测试的样板。
 *
 * 前置：vitest globalSetup 已自动 yarn seed + yarn e2e:login（见 tests/setup.ts）
 *
 * 跑法：yarn test:integration
 */
import { describe, it, expect } from 'vitest';
import { allHttpFromTokensFile } from '../helpers';

describe('D6 测试基建契约 · 烟雾', () => {
  it('system 子系统能用 /me 拿身份', async () => {
    const http = await allHttpFromTokensFile();
    const r = await http.system.get('/me');
    expect(r.status).toBe(200);
    expect((r.data as { email: string }).email).toBe('platform-admin@local.test');
  });

  it('admin 子系统能用 /me 拿身份', async () => {
    const http = await allHttpFromTokensFile();
    const r = await http.acmeAdmin.get('/me');
    expect(r.status).toBe(200);
    expect((r.data as { email: string }).email).toBe('admin@acme.test');
  });

  // customer 子系统的 /me 已清空（只保留 POST /login）—— 改测 login
  it('customer 子系统 POST /login → 200 + JWT', async () => {
    const r = await axiosLoginCustomer();
    expect(r.status).toBe(200);
    expect((r.data as { token: string }).token).toMatch(/^eyJ/);
  });

  it('对外 API Key 鉴权能穿透到 /chat', async () => {
    const http = await allHttpFromTokensFile();
    const r = await http.acmeApiKey.post('/chat', {}, { validateStatus: () => true });
    // 401 = 鉴权失败；其他 = 鉴权过（业务层报错也 OK）
    expect(r.status).not.toBe(401);
  });
});

async function axiosLoginCustomer(): Promise<{ status: number; data: unknown }> {
  // 简单直接走 fetch；fixture 凭据在 .e2e-tokens.json 已有，重复登录确认 API 通
  const r = await import('axios').then((m) =>
    m.default.post(
      'http://localhost:3000/api/v1/customer/login',
      { email: 'alice@acme.test', password: 'AcmeCustomer-123!', tenant_code: 'acme' },
      { validateStatus: () => true },
    ),
  );
  return { status: r.status, data: r.data };
}
