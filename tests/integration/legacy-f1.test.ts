/**
 * tests/integration/legacy-f1.test.ts
 * 历史 F1 验收：system 端租户管理（4 个端点 + 重置密码 + 跨子系统防御）
 * 已转为 vitest 格式
 *
 * 注：与 legacy-step2.test.ts 互补 —— step2 测「建租户 + admin user mgmt」，
 *     f1 测「列租户 / 详情 / 改名 / 重置密码 + 跨子系统防御」
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import axios from 'axios';
import { getSequelize } from '../../src/db';
import { Tenant, User } from '../../src/models';
import { signToken } from '../../src/lib/jwt';
import { hashPassword } from '../../src/lib/password';

const BASE = `http://localhost:${process.env.PORT ?? '3099'}`;

describe('legacy F1 · system 端租户管理', () => {
  const testCode = `f1-${Date.now()}`;
  const adminEmail = `f1-admin-${Date.now()}@f1.test`;
  let tenantId = '';
  let adminUserId = '';
  let sysToken = '';
  let adminToken = '';

  beforeAll(async () => {
    getSequelize();
    const sysUser = await (
      await import('../../src/models')
    ).SystemUser.findOne({ where: { email: 'platform-admin@local.test' } });
    if (sysUser === null) throw new Error('system user 不存在，先跑 yarn seed');
    sysToken = signToken({ sub: sysUser.id, role: 'system' });

    await Tenant.destroy({ where: { code: { [Symbol.for('like')]: 'f1-%' } } });
    const t = await Tenant.create({ code: testCode, name: 'F1 Tenant' });
    tenantId = t.id;
    const admin = await User.create({
      tenant_id: tenantId,
      email: adminEmail,
      password_hash: await hashPassword('Original-123'),
      role: 'admin',
      must_change_password: false,
    });
    adminUserId = admin.id;
    adminToken = signToken({ sub: admin.id, tenant_id: tenantId, role: 'admin' });
  });

  afterAll(async () => {
    await User.destroy({ where: { id: adminUserId } });
    await Tenant.destroy({ where: { id: tenantId } });
  });

  async function sysReq<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    return axios.request<T>({
      method,
      url: `${BASE}/api/v1/system${path}`,
      data: body,
      headers: { authorization: `Bearer ${sysToken}`, 'content-type': 'application/json' },
      validateStatus: () => true,
    }).then((r) => ({ status: r.status, data: r.data }));
  }

  it('GET /system/tenants 列表含新建', async () => {
    const r = await sysReq<{ tenants: Array<{ code: string; admin: { email: string } | null }> }>('GET', '/tenants');
    expect(r.status).toBe(200);
    const found = r.data.tenants.find((t) => t.code === testCode);
    expect(found).toBeDefined();
    expect(found?.admin?.email).toBe(adminEmail);
  });

  it('GET /system/tenants/:id 详情', async () => {
    const r = await sysReq<{ id: string; admin: { email: string } | null }>('GET', `/tenants/${tenantId}`);
    expect(r.status).toBe(200);
    expect(r.data.id).toBe(tenantId);
    expect(r.data.admin?.email).toBe(adminEmail);
  });

  it('PATCH /system/tenants/:id 改名 + 改 plan', async () => {
    const r = await sysReq<{ name: string; plan: string }>('PATCH', `/tenants/${tenantId}`, {
      name: 'F1 (renamed)',
      plan: 'pro',
    });
    expect(r.status).toBe(200);
    expect(r.data.name).toBe('F1 (renamed)');
    expect(r.data.plan).toBe('pro');
  });

  it('POST /system/tenants/:id/admin/reset-password → must_change_password=true', async () => {
    const r = await sysReq<{ admin: { must_change_password: boolean } }>(
      'POST',
      `/tenants/${tenantId}/admin/reset-password`,
      { new_password: 'Reset-456' },
    );
    expect(r.status).toBe(200);
    expect(r.data.admin?.must_change_password).toBe(true);
  });

  it('新密码能登 admin（确认重置生效）', async () => {
    const r = await axios.post(`${BASE}/api/v1/admin/login`, {
      email: adminEmail,
      password: 'Reset-456',
      tenant_code: testCode,
    }, { validateStatus: () => true });
    expect(r.status).toBe(200);
  });

  it('旧密码登不上（确认被覆盖）', async () => {
    const r = await axios.post(`${BASE}/api/v1/admin/login`, {
      email: adminEmail,
      password: 'Original-123',
      tenant_code: testCode,
    }, { validateStatus: () => true });
    expect(r.status).toBe(401);
  });

  it('admin token 调 /system/tenants → 401（跨子系统防御）', async () => {
    const r = await axios.get(`${BASE}/api/v1/system/tenants`, {
      headers: { authorization: `Bearer ${adminToken}` },
      validateStatus: () => true,
    });
    expect(r.status).toBe(401);
  });
});
