/**
 * vitest 烟雾测试 —— docs/16-d §D6 测试基建契约
 *
 * 验证 scripts/_lib 全套（fixtures + auth + http）可用。
 * 用 vitest 标准 describe/it/expect 写，是新写的集成测试的样板。
 *
 * 前置：vitest globalSetup 已自动 yarn seed + yarn e2e:login（见 tests/setup.ts）
 *
 * 跑法：yarn test:integration
 *
 * （/me + /chat 端点已删除 —— 改为测登录路径验证子系统存活）
 */
import { describe, it, expect } from 'vitest';
import axios from 'axios';
import { allHttpFromTokensFile, apiBase } from '../helpers';

describe('D6 测试基建契约 · 烟雾', () => {
  it('system 子系统 POST /login → 200 + JWT', async () => {
    const r = await axios.post(
      `${apiBase()}/api/v1/system/login`,
      { email: 'platform-admin@local.test', password: 'PlatformAdmin-123!' },
      { validateStatus: () => true },
    );
    expect(r.status).toBe(200);
    expect((r.data as { token: string }).token).toMatch(/^eyJ/);
  });

  it('admin 子系统 POST /login → 200 + JWT（acme）', async () => {
    const r = await axios.post(
      `${apiBase()}/api/v1/admin/login`,
      { email: 'admin@acme.test', password: 'AcmeAdmin-123!', tenant_code: 'acme' },
      { validateStatus: () => true },
    );
    expect(r.status).toBe(200);
    expect((r.data as { token: string }).token).toMatch(/^eyJ/);
  });

  it('customer 子系统 POST /login → 200 + JWT', async () => {
    const r = await axiosLoginCustomer();
    expect(r.status).toBe(200);
    expect((r.data as { token: string }).token).toMatch(/^eyJ/);
  });

  it('dev-probe /jwt-info 能解码 token', async () => {
    const http = await allHttpFromTokensFile();
    const r = await axios.get(`${apiBase()}/api/_dev/jwt-info`, {
      headers: { authorization: http.acmeAdmin.defaults.headers.authorization },
      validateStatus: () => true,
    });
    expect(r.status).toBe(200);
    expect((r.data as { ok: boolean }).ok).toBe(true);
  });
});

async function axiosLoginCustomer(): Promise<{ status: number; data: unknown }> {
  const r = await import('axios').then((m) =>
    m.default.post(
      `${apiBase()}/api/v1/customer/login`,
      { email: 'alice@acme.test', password: 'AcmeCustomer-123!', tenant_code: 'acme' },
      { validateStatus: () => true },
    ),
  );
  return { status: r.status, data: r.data };
}
