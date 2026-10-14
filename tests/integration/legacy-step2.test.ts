/**
 * tests/integration/legacy-step2.test.ts
 * 历史 Step 2 验收：建租户 + 初始 admin + admin 端 user 管理 + change-password
 * 已转为 vitest 格式（docs/18 §18.4.2 改造）
 * 保留独立 step2-* 租户避免和全局 fixture（acme/globex）冲突
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import axios from 'axios';
import { getSequelize } from '../../src/db';
import { Tenant, User } from '../../src/models';
import { hashPassword } from '../../src/lib/password';

const BASE = `http://localhost:${process.env.PORT ?? '3000'}`;

async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== undefined) headers['authorization'] = `Bearer ${token}`;
  return axios
    .request<T>({ method, url: `${BASE}${path}`, data: body, headers, validateStatus: () => true })
    .then((r) => ({ status: r.status, data: r.data }))
    .catch((e: { response?: { status?: number; data?: T } }) => ({
      status: e.response?.status ?? 0,
      data: e.response?.data as T,
    }));
}

describe('legacy Step 2 · 建租户 + admin user 管理', () => {
  const code = `step2-${Date.now()}`;
  const adminEmail = `step2-${Date.now()}@step2.test`;
  const adminPassword = 'Step2Pwd-123';
  let sysToken = '';
  let tenantId = '';
  let adminUserId = '';

  beforeAll(async () => {
    getSequelize();

    // 拿 system user 直接签 JWT（不依赖 /login）
    const sysUser = await (
      await import('../../src/models')
    ).SystemUser.findOne({ where: { email: 'platform-admin@local.test' } });
    if (sysUser === null) throw new Error('system user 不存在，先跑 yarn seed');
    sysToken = (await import('../../src/lib/jwt')).signToken({ sub: sysUser.id, role: 'system' });

    // 清理 + 建租户
    await Tenant.destroy({ where: { code: { [Symbol.for('like')]: 'step2-%' } } });
    const tenant = await Tenant.create({ code, name: 'Step2 Tenant' });
    tenantId = tenant.id;
    const admin = await User.create({
      tenant_id: tenantId,
      email: adminEmail,
      password_hash: await hashPassword(adminPassword),
      role: 'admin',
      must_change_password: false,
    });
    adminUserId = admin.id;
  });

  afterAll(async () => {
    await User.destroy({ where: { id: adminUserId } });
    await Tenant.destroy({ where: { id: tenantId } });
  });

  it('POST /system/tenants 建租户（用 system token 直接调）', async () => {
    const r = await api('POST', '/api/v1/system/tenants', {
      code: `${code}-extra`,
      name: 'Step2 Extra',
      admin_email: `step2-extra-${Date.now()}@step2.test`,
      admin_password: 'Step2Extra-123',
    }, sysToken);
    expect(r.status).toBe(201);
    const data = r.data as { tenant: { code: string }; admin: { email: string } };
    expect(data.tenant.code).toBe(`${code}-extra`);

    // 清理
    await User.destroy({ where: { email: data.admin.email } });
    await Tenant.destroy({ where: { code: data.tenant.code } });
  });

  it('重复提交同 code → 400', async () => {
    const r = await api('POST', '/api/v1/system/tenants', {
      code,
      name: 'X',
      admin_email: 'whatever@x.test',
      admin_password: 'Whatever-123',
    }, sysToken);
    expect(r.status).toBe(400);
  });

  it('admin 登录拿 token', async () => {
    const r = await api('POST', '/api/v1/admin/login', {
      email: adminEmail,
      password: adminPassword,
      tenant_code: code,
    });
    expect(r.status).toBe(200);
    expect((r.data as { token: string }).token).toMatch(/^eyJ/);
  });

  it('GET /admin/users 列租户用户（含自己）', async () => {
    const login = await api('POST', '/api/v1/admin/login', {
      email: adminEmail,
      password: adminPassword,
      tenant_code: code,
    });
    const token = (login.data as { token: string }).token;
    const r = await api('GET', '/api/v1/admin/users', undefined, token);
    expect(r.status).toBe(200);
    const emails = (r.data as { users: Array<{ email: string }> }).users.map((u) => u.email);
    expect(emails).toContain(adminEmail);
  });

  it('POST /admin/users 建第二个 user', async () => {
    const login = await api('POST', '/api/v1/admin/login', {
      email: adminEmail,
      password: adminPassword,
      tenant_code: code,
    });
    const token = (login.data as { token: string }).token;
    const newEmail = `step2-user2-${Date.now()}@step2.test`;
    const r = await api('POST', '/api/v1/admin/users', {
      email: newEmail,
      password: 'User2Pwd-123',
      role: 'customer',
    }, token);
    expect(r.status).toBe(201);

    // 清理
    await User.destroy({ where: { email: newEmail } });
  });

  it('同邮箱再 POST → 400', async () => {
    const login = await api('POST', '/api/v1/admin/login', {
      email: adminEmail,
      password: adminPassword,
      tenant_code: code,
    });
    const token = (login.data as { token: string }).token;
    const r = await api('POST', '/api/v1/admin/users', {
      email: adminEmail,
      password: 'DupPwd-123',
      role: 'customer',
    }, token);
    expect(r.status).toBe(400);
  });

  it('PATCH /admin/users/:id 改密', async () => {
    const login = await api('POST', '/api/v1/admin/login', {
      email: adminEmail,
      password: adminPassword,
      tenant_code: code,
    });
    const token = (login.data as { token: string }).token;
    const r = await api('PATCH', `/api/v1/admin/users/${adminUserId}`, {
      password: 'NewStep2Pwd-456',
    }, token);
    expect(r.status).toBe(200);
    // 验证新密码能登
    const newLogin = await api('POST', '/api/v1/admin/login', {
      email: adminEmail,
      password: 'NewStep2Pwd-456',
      tenant_code: code,
    });
    expect(newLogin.status).toBe(200);
    // 还原
    await User.update({ password_hash: await hashPassword(adminPassword) }, { where: { id: adminUserId } });
  });

  it('DELETE /admin/users/:id 删新建 user', async () => {
    const login = await api('POST', '/api/v1/admin/login', {
      email: adminEmail,
      password: adminPassword,
      tenant_code: code,
    });
    const token = (login.data as { token: string }).token;
    // 先建
    const email = `step2-del-${Date.now()}@step2.test`;
    const created = await api('POST', '/api/v1/admin/users', {
      email,
      password: 'DelPwd-123',
      role: 'customer',
    }, token);
    const id = (created.data as { id: string }).id;
    // 删
    const r = await api('DELETE', `/api/v1/admin/users/${id}`, undefined, token);
    expect(r.status).toBe(204);
  });

  it('POST /admin/change-password 改密 + 旧密码失效', async () => {
    const login = await api('POST', '/api/v1/admin/login', {
      email: adminEmail,
      password: adminPassword,
      tenant_code: code,
    });
    const token = (login.data as { token: string }).token;
    const r = await api('POST', '/api/v1/admin/change-password', {
      old_password: adminPassword,
      new_password: 'ChangedPwd-789',
    }, token);
    expect(r.status).toBe(200);
    // 旧密码登不上
    const oldLogin = await api('POST', '/api/v1/admin/login', {
      email: adminEmail,
      password: adminPassword,
      tenant_code: code,
    });
    expect(oldLogin.status).toBe(401);
    // 还原（不然其他测试受影响）
    await User.update({ password_hash: await hashPassword(adminPassword) }, { where: { id: adminUserId } });
  });
});
