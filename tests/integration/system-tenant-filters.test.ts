/**
 * tests/integration/system-tenant-filters.test.ts
 * 租户列表的**筛选 / 用户数 / 到期标记** + 建租户时的**套餐 / 到期时间**
 *
 * 对应 src/gateway/system/tenant-routes.ts
 * 规格：docs/04-d-ui-系统级与公共组件.md §6.1「租户列表」+「租户详情」
 *
 * ⚠️ 这些是 2026-10-25 补的 —— 以前列表没有筛选、没有用户数列，
 *    「创建租户」表单里也没有套餐和到期时间（04-d §6.1 都写了）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Op } from 'sequelize';
import { allHttpFromTokensFile, type AllHttp } from '../helpers';
import { getSequelize } from '../../src/db';
import { Tenant, User } from '../../src/models';

describe('租户列表 · 筛选 + 用户数 + 到期标记', () => {
  let http: AllHttp;
  const createdCodes: string[] = [];

  beforeAll(async () => {
    getSequelize();
    http = await allHttpFromTokensFile();
  });

  afterAll(async () => {
    if (createdCodes.length > 0) {
      // 先删用户（外键），再删租户
      const tenants = await Tenant.findAll({ where: { code: { [Op.in]: createdCodes } } });
      const ids = tenants.map((t) => t.id);
      if (ids.length > 0) {
        await User.destroy({ where: { tenant_id: { [Op.in]: ids } } });
        await Tenant.destroy({ where: { id: { [Op.in]: ids } } });
      }
    }
  });

  const createTenant = async (
    code: string,
    extra: { plan?: string; expires_at?: string | null } = {},
  ): Promise<string> => {
    createdCodes.push(code);
    const res = await http.system.post(
      '/tenants',
      {
        code,
        name: `测试租户 ${code}`,
        admin_email: `admin-${code}@test.local`,
        admin_password: 'TestPass-123!',
        ...extra,
      },
      { validateStatus: () => true },
    );
    expect(res.status).toBe(201);
    return code;
  };

  it('列表带上用户数 + 已到期标记', async () => {
    const res = await http.system.get('/tenants', { validateStatus: () => true });
    expect(res.status).toBe(200);
    const tenants = (res.data as { tenants: Array<Record<string, unknown>> }).tenants;
    expect(tenants.length).toBeGreaterThan(0);
    for (const t of tenants) {
      expect(typeof t['user_count']).toBe('number');
      expect(typeof t['expired']).toBe('boolean');
    }
  });

  it('关键词筛选：按租户号能筛到', async () => {
    await createTenant('filter-kw-1');
    const res = await http.system.get('/tenants', {
      params: { keyword: 'filter-kw-1' },
      validateStatus: () => true,
    });
    expect(res.status).toBe(200);
    const tenants = (res.data as { tenants: Array<{ code: string }> }).tenants;
    expect(tenants.length).toBeGreaterThan(0);
    expect(tenants.every((t) => t.code.includes('filter-kw-1'))).toBe(true);
  });

  it('关键词筛选：按名称也能筛到', async () => {
    await createTenant('filter-kw-2');
    const res = await http.system.get('/tenants', {
      params: { keyword: 'filter-kw-2' },
      validateStatus: () => true,
    });
    const tenants = (res.data as { tenants: Array<{ name: string }> }).tenants;
    expect(tenants.length).toBeGreaterThan(0);
    expect(tenants.every((t) => t.name.includes('filter-kw-2'))).toBe(true);
  });

  it('套餐筛选：跟关键词筛选是「与」的关系，不是互相覆盖', async () => {
    // ⚠️ 回归：之前 where 被 spread 两次，后者会覆盖前者 ——
    //    带 plan + keyword 两个条件时，keyword 会被吃掉
    await createTenant('filter-both-1', { plan: 'enterprise' });
    const res = await http.system.get('/tenants', {
      params: { keyword: 'filter-both-1', plan: 'enterprise' },
      validateStatus: () => true,
    });
    const tenants = (res.data as { tenants: Array<{ code: string; plan: string }> }).tenants;
    expect(tenants.length).toBe(1);
    expect(tenants[0]?.code).toBe('filter-both-1');
    expect(tenants[0]?.plan).toBe('enterprise');
  });

  it('套餐筛选：单独用也能筛', async () => {
    const res = await http.system.get('/tenants', {
      params: { plan: 'enterprise' },
      validateStatus: () => true,
    });
    const tenants = (res.data as { tenants: Array<{ plan: string }> }).tenants;
    expect(tenants.length).toBeGreaterThan(0);
    expect(tenants.every((t) => t.plan === 'enterprise')).toBe(true);
  });

  it('建租户时可以带套餐 + 到期时间', async () => {
    const code = 'filter-plan-1';
    createdCodes.push(code);
    const res = await http.system.post(
      '/tenants',
      {
        code,
        name: '测试套餐租户',
        admin_email: `admin-${code}@test.local`,
        admin_password: 'TestPass-123!',
        plan: 'pro',
        expires_at: '2030-01-01T00:00:00.000Z',
      },
      { validateStatus: () => true },
    );
    expect(res.status).toBe(201);
    const tenant = (res.data as { tenant: { plan: string; expires_at: string | null } }).tenant;
    expect(tenant.plan).toBe('pro');
    expect(tenant.expires_at).not.toBeNull();

    // 回查库里确认真的写进去了
    const row = await Tenant.findOne({ where: { code } });
    expect(row?.plan).toBe('pro');
    expect(row?.expires_at).not.toBeNull();
  });

  it('建租户不传套餐/到期时用默认值（free / 永不过期）', async () => {
    const code = 'filter-default-1';
    createdCodes.push(code);
    const res = await http.system.post(
      '/tenants',
      {
        code,
        name: '测试默认租户',
        admin_email: `admin-${code}@test.local`,
        admin_password: 'TestPass-123!',
      },
      { validateStatus: () => true },
    );
    expect(res.status).toBe(201);
    const tenant = (res.data as { tenant: { plan: string; expires_at: string | null } }).tenant;
    expect(tenant.plan).toBe('free');
    expect(tenant.expires_at).toBeNull();
  });

  it('已到期的租户能被状态筛选单独筛出来', async () => {
    const code = 'filter-expired-1';
    createdCodes.push(code);
    // 建一个已经到期的租户
    const res = await http.system.post(
      '/tenants',
      {
        code,
        name: '测试过期租户',
        admin_email: `admin-${code}@test.local`,
        admin_password: 'TestPass-123!',
        expires_at: '2020-01-01T00:00:00.000Z',
      },
      { validateStatus: () => true },
    );
    expect(res.status).toBe(201);

    const expired = await http.system.get('/tenants', {
      params: { status: 'expired' },
      validateStatus: () => true,
    });
    const list = (expired.data as { tenants: Array<{ code: string }> }).tenants;
    expect(list.some((t) => t.code === code)).toBe(true);

    // 它不该出现在「启用中」里
    const active = await http.system.get('/tenants', {
      params: { status: 'active' },
      validateStatus: () => true,
    });
    const activeList = (active.data as { tenants: Array<{ code: string }> }).tenants;
    expect(activeList.some((t) => t.code === code)).toBe(false);
  });

  it('租户详情带规模统计（用户数 / 会话数 / 文档数 / 累计花费）', async () => {
    const list = await http.system.get('/tenants');
    const acme = (list.data as { tenants: Array<{ id: string; code: string }> }).tenants.find(
      (t) => t.code === 'acme',
    );
    expect(acme).toBeDefined();

    const res = await http.system.get(`/tenants/${acme?.id ?? ''}`, {
      validateStatus: () => true,
    });
    expect(res.status).toBe(200);
    const stats = (res.data as { stats: Record<string, number> }).stats;
    expect(typeof stats['user_count']).toBe('number');
    expect(typeof stats['session_count']).toBe('number');
    expect(typeof stats['document_count']).toBe('number');
    expect(typeof stats['total_cost_usd']).toBe('number');
    // acme 的用户肯定不止 0 个
    expect(stats['user_count']).toBeGreaterThan(0);
  });
});
