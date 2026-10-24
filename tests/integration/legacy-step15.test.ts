/**
 * tests/integration/legacy-step15.test.ts
 * 历史 Step 15 / F2 验收：租户启停 + 到期时间
 * 已转为 vitest 格式
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import axios from 'axios';
import { getSequelize } from '../../src/db';
import { Tenant, User, AuditLog } from '../../src/models';
import { signToken } from '../../src/lib/jwt';
import { hashPassword } from '../../src/lib/password';
import { apiBase } from '../helpers';

const BASE = apiBase();

describe('legacy Step 15 / F2 · 租户启停 + 到期', () => {
  const testCode = `step15-${Date.now()}`;
  let tenantId = '';
  let adminUserId = '';
  let sysToken = '';
  let adminEmail = '';
  const pwd = 'Step15-123';

  beforeAll(async () => {
    getSequelize();
    const sysUser = await (
      await import('../../src/models')
    ).SystemUser.findOne({ where: { email: 'platform-admin@local.test' } });
    if (sysUser === null) throw new Error('system user 不存在，先跑 yarn seed');
    sysToken = signToken({ sub: sysUser.id, role: 'system' });

    await Tenant.destroy({ where: { code: { [Symbol.for('like')]: 'step15-%' } } });
    const t = await Tenant.create({ code: testCode, name: 'Step15 Tenant' });
    tenantId = t.id;
    adminEmail = `step15-${Date.now()}@step15.test`;
    const admin = await User.create({
      tenant_id: tenantId,
      email: adminEmail,
      password_hash: await hashPassword(pwd),
      role: 'admin',
      must_change_password: false,
    });
    adminUserId = admin.id;
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

  it('GET /system/tenants 列表含 status + expires_at（F2 字段）', async () => {
    const r = await sysReq<{ tenants: Array<{ code: string; status: string; expires_at: Date | null }> }>('GET', '/tenants');
    expect(r.status).toBe(200);
    const found = r.data.tenants.find((t) => t.code === testCode);
    expect(found?.status).toBe('active');
    expect(found?.expires_at).toBeNull();
  });

  it('PATCH /tenants/:id/expires_at 设置到期时间', async () => {
    const iso = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const r = await sysReq<{ expires_at: Date }>('PATCH', `/tenants/${tenantId}/expires_at`, {
      expires_at: iso,
    });
    expect(r.status).toBe(200);
    expect(new Date(r.data.expires_at).toISOString()).toBe(iso);
  });

  it('PATCH /tenants/:id/expires_at 清空到期（expires_at=null）', async () => {
    const r = await sysReq<{ expires_at: Date | null }>('PATCH', `/tenants/${tenantId}/expires_at`, {
      expires_at: null,
    });
    expect(r.status).toBe(200);
    expect(r.data.expires_at).toBeNull();
  });

  it('PATCH /tenants/:id/status active → disabled', async () => {
    const r = await sysReq<{ status: string }>('PATCH', `/tenants/${tenantId}/status`, {
      status: 'disabled',
    });
    expect(r.status).toBe(200);
    expect(r.data.status).toBe('disabled');
  });

  it('disabled 租户的 admin 登不上 → 401（闸门联动）', async () => {
    const r = await axios.post(`${BASE}/api/v1/admin/login`, {
      email: adminEmail,
      password: pwd,
      tenant_code: testCode,
    }, { validateStatus: () => true });
    expect(r.status).toBe(401);
  });

  it('disabled 租户的 customer 登不上 → 401', async () => {
    const r = await axios.post(`${BASE}/api/v1/customer/login`, {
      email: adminEmail, // 用 admin 邮箱登 customer 也试一下
      password: pwd,
      tenant_code: testCode,
    }, { validateStatus: () => true });
    expect(r.status).toBe(401);
  });

  it('PATCH /tenants/:id/status disabled → active（恢复）', async () => {
    const r = await sysReq<{ status: string }>('PATCH', `/tenants/${tenantId}/status`, {
      status: 'active',
    });
    expect(r.status).toBe(200);
    expect(r.data.status).toBe('active');
  });

  it('恢复后 admin 能登', async () => {
    const r = await axios.post(`${BASE}/api/v1/admin/login`, {
      email: adminEmail,
      password: pwd,
      tenant_code: testCode,
    }, { validateStatus: () => true });
    expect(r.status).toBe(200);
  });

  it('到期时间设成过去 → admin 登不上 → 401', async () => {
    // 设成过去
    await sysReq('PATCH', `/tenants/${tenantId}/expires_at`, {
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    const r = await axios.post(`${BASE}/api/v1/admin/login`, {
      email: adminEmail,
      password: pwd,
      tenant_code: testCode,
    }, { validateStatus: () => true });
    expect(r.status).toBe(401);
    // 还原：清空到期
    await sysReq('PATCH', `/tenants/${tenantId}/expires_at`, { expires_at: null });
  });

  it('audit_logs 写了 TENANT_STATUS_CHANGE / TENANT_EXPIRES_CHANGE', async () => {
    // 触发一次写审计的操作
    await sysReq('PATCH', `/tenants/${tenantId}/expires_at`, {
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const rows = await AuditLog.findAll({
      where: { resource_id: tenantId },
      order: [['created_at', 'DESC']],
      limit: 10,
    });
    const actions = rows.map((r) => r.action);
    expect(actions).toContain('TENANT_STATUS_CHANGE');
    expect(actions).toContain('TENANT_EXPIRES_CHANGE');
    // 清理
    await sysReq('PATCH', `/tenants/${tenantId}/expires_at`, { expires_at: null });
  });
});
