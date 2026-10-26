/**
 * vitest 烟雾测试 —— docs/12-d §D6 测试基建契约
 *
 * 验证测试基建全套（fixtures + auth + http）可用。
 * 用 vitest 标准 describe/it/expect 写，是新写的集成测试的样板。
 *
 * 前置：vitest globalSetup 已自动 yarn seed + yarn e2e:login（见 tests/setup.ts）
 *
 * 跑法：yarn test:integration
 *
 * ## 覆盖的 4 条（与 12-d §D6 的验收口径一一对应）
 *
 *  1. system   POST /login → 200 + JWT，GET /me → 200
 *  2. admin    POST /login → 200 + JWT，GET /me → 200
 *  3. customer POST /login → 200 + JWT，GET /me → 200
 *  4. acmeApiKey POST /chat → 鉴权过（不是 401）
 *
 * ⚠️ **历史**：这个文件以前只测登录，注释写着「/me + /chat 端点已删除」——
 *    但那两个端点**已经补回来了**（/me 是 2026-10-25 按 A4 补的，
 *    /chat 是 E1 对外 API），注释和 12-d §D6 的验收口径因此对不上。
 *    2026-10-26 按验收口径改齐。
 */
import { describe, it, expect } from 'vitest';
import axios from 'axios';
import { allHttpFromTokensFile, apiBase } from '../helpers';

describe('D6 测试基建契约 · 烟雾', () => {
  it('system 子系统：POST /login → 200 + JWT，GET /me → 200', async () => {
    const r = await axios.post(
      `${apiBase()}/api/v1/system/login`,
      { email: 'platform-admin@local.test', password: 'PlatformAdmin-123!' },
      { validateStatus: () => true },
    );
    expect(r.status).toBe(200);
    const token = (r.data as { token: string }).token;
    expect(token).toMatch(/^eyJ/);

    const me = await axios.get(`${apiBase()}/api/v1/system/me`, {
      headers: { authorization: `Bearer ${token}` },
      validateStatus: () => true,
    });
    expect(me.status).toBe(200);
  });

  it('admin 子系统：POST /login → 200 + JWT，GET /me → 200（acme）', async () => {
    const r = await axios.post(
      `${apiBase()}/api/v1/admin/login`,
      { email: 'admin@acme.test', password: 'AcmeAdmin-123!', tenant_code: 'acme' },
      { validateStatus: () => true },
    );
    expect(r.status).toBe(200);
    const token = (r.data as { token: string }).token;
    expect(token).toMatch(/^eyJ/);

    const me = await axios.get(`${apiBase()}/api/v1/admin/me`, {
      headers: { authorization: `Bearer ${token}` },
      validateStatus: () => true,
    });
    expect(me.status).toBe(200);
    expect((me.data as { user: { role: string } }).user.role).toBe('admin');
  });

  it('customer 子系统：POST /login → 200 + JWT，GET /me → 200', async () => {
    const r = await axios.post(
      `${apiBase()}/api/v1/customer/login`,
      { email: 'alice@acme.test', password: 'AcmeCustomer-123!', tenant_code: 'acme' },
      { validateStatus: () => true },
    );
    expect(r.status).toBe(200);
    const token = (r.data as { token: string }).token;
    expect(token).toMatch(/^eyJ/);

    const me = await axios.get(`${apiBase()}/api/v1/customer/me`, {
      headers: { authorization: `Bearer ${token}` },
      validateStatus: () => true,
    });
    expect(me.status).toBe(200);
    expect((me.data as { user: { role: string } }).user.role).toBe('customer');
  });

  it('acmeApiKey POST /chat → 鉴权过（不是 401）', async () => {
    const http = await allHttpFromTokensFile();
    // ⚠️ **故意发一个空 body**：`question` 是必填的（`askBodySchema`），
    //    所以请求会在「鉴权 + scope 闸门通过之后」停在 body 校验上 → 400。
    //    这样既证明了**鉴权过了**（过了才会走到 body 校验），
    //    又**不会真的调 LLM**（烟雾测试必须是零费用的）。
    const r = await http.acmeApiKey.post('/public/chat', {}, { validateStatus: () => true });
    expect(r.status).toBe(400);
    expect(r.status).not.toBe(401);
    expect(r.status).not.toBe(403);
  });
});
