/**
 * tests/integration/legacy-step3.test.ts
 * 历史 Step 3 验收：三层登录 + 跨子系统防御
 * 已转为 vitest 格式
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import axios from 'axios';
import { getSequelize } from '../../src/db';
import { Tenant, User } from '../../src/models';
import { hashPassword } from '../../src/lib/password';

const BASE = `http://localhost:${process.env.PORT ?? '3000'}`;

describe('legacy Step 3 · 三层登录 + 跨子系统防御', () => {
  const code = `step3-${Date.now()}`;
  const adminEmail = `step3-admin-${Date.now()}@step3.test`;
  const customerEmail = `step3-cust-${Date.now()}@step3.test`;
  const pwd = 'Step3Pwd-123';
  let tenantId = '';
  let adminId = '';
  let customerId = '';

  beforeAll(async () => {
    getSequelize();
    await Tenant.destroy({ where: { code: { [Symbol.for('like')]: 'step3-%' } } });
    const t = await Tenant.create({ code, name: 'Step3 Tenant' });
    tenantId = t.id;
    const admin = await User.create({
      tenant_id: tenantId,
      email: adminEmail,
      password_hash: await hashPassword(pwd),
      role: 'admin',
      must_change_password: false,
    });
    adminId = admin.id;
    const cust = await User.create({
      tenant_id: tenantId,
      email: customerEmail,
      password_hash: await hashPassword(pwd),
      role: 'customer',
      must_change_password: false,
    });
    customerId = cust.id;
  });

  afterAll(async () => {
    await User.destroy({ where: { id: [adminId, customerId] } });
    await Tenant.destroy({ where: { id: tenantId } });
  });

  async function postLogin(path: string, body: unknown): Promise<{ status: number; token: string }> {
    return axios
      .post(`${BASE}${path}`, body, { validateStatus: () => true })
      .then((r) => ({ status: r.status, token: (r.data as { token?: string }).token ?? '' }));
  }

  describe('system 子系统', () => {
    it('system user 登录 → JWT', async () => {
      const r = await postLogin('/api/v1/system/login', {
        email: 'platform-admin@local.test',
        password: 'PlatformAdmin-123!',
      });
      expect(r.status).toBe(200);
      expect(r.token).toMatch(/^eyJ/);
    });

    it('system 邮箱错密码 → 401', async () => {
      const r = await postLogin('/api/v1/system/login', {
        email: 'platform-admin@local.test',
        password: 'wrong',
      });
      expect(r.status).toBe(401);
    });
  });

  describe('admin 子系统', () => {
    it('admin 登录 → JWT', async () => {
      const r = await postLogin('/api/v1/admin/login', {
        email: adminEmail,
        password: pwd,
        tenant_code: code,
      });
      expect(r.status).toBe(200);
      expect(r.token).toMatch(/^eyJ/);
    });

    it('admin 密码错 → 401', async () => {
      const r = await postLogin('/api/v1/admin/login', {
        email: adminEmail,
        password: 'wrong',
        tenant_code: code,
      });
      expect(r.status).toBe(401);
    });

    it('admin 用 customer 账号登 → 401（角色锁死）', async () => {
      const r = await postLogin('/api/v1/admin/login', {
        email: customerEmail,
        password: pwd,
        tenant_code: code,
      });
      expect(r.status).toBe(401);
    });
  });

  describe('customer 子系统', () => {
    it('customer 登录 → JWT', async () => {
      const r = await postLogin('/api/v1/customer/login', {
        email: customerEmail,
        password: pwd,
        tenant_code: code,
      });
      expect(r.status).toBe(200);
      expect(r.token).toMatch(/^eyJ/);
    });

    it('customer 用 admin 账号登 → 401', async () => {
      const r = await postLogin('/api/v1/customer/login', {
        email: adminEmail,
        password: pwd,
        tenant_code: code,
      });
      expect(r.status).toBe(401);
    });
  });

  describe('跨子系统防御（用 token）', () => {
    it('admin token 调 system 子系统 → 401', async () => {
      const adminLogin = await postLogin('/api/v1/admin/login', {
        email: adminEmail, password: pwd, tenant_code: code,
      });
      const r = await axios.get(`${BASE}/api/v1/system/me`, {
        headers: { authorization: `Bearer ${adminLogin.token}` },
        validateStatus: () => true,
      });
      expect(r.status).toBe(401);
    });

    it('customer token 调 admin 子系统 → 403', async () => {
      const custLogin = await postLogin('/api/v1/customer/login', {
        email: customerEmail, password: pwd, tenant_code: code,
      });
      const r = await axios.get(`${BASE}/api/v1/admin/me`, {
        headers: { authorization: `Bearer ${custLogin.token}` },
        validateStatus: () => true,
      });
      expect([401, 403]).toContain(r.status);
    });

    it('customer token 调 system 子系统 → 401', async () => {
      const custLogin = await postLogin('/api/v1/customer/login', {
        email: customerEmail, password: pwd, tenant_code: code,
      });
      const r = await axios.get(`${BASE}/api/v1/system/me`, {
        headers: { authorization: `Bearer ${custLogin.token}` },
        validateStatus: () => true,
      });
      expect(r.status).toBe(401);
    });
  });

  describe('跨租户防御', () => {
    it('tenantA 的 admin 邮箱在 tenantB 登不上', async () => {
      const r = await postLogin('/api/v1/admin/login', {
        email: adminEmail,
        password: pwd,
        tenant_code: 'acme', // 不是 tenantA 的 code
      });
      expect(r.status).toBe(401);
    });
  });
});
