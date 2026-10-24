/**
 * tests/integration/system-stats.test.ts
 * 对应 src/gateway/system/tenant-routes.ts 的 GET /stats（平台方总览）
 * 详见 docs/04-d-ui-系统级与公共组件.md §6.2
 */
import { describe, it, expect, beforeAll } from 'vitest';
import axios from 'axios';
import { apiBase,  allHttpFromTokensFile, type AllHttp } from '../helpers';

const BASE = apiBase();

interface SystemStatsBody {
  tenants: {
    total: number;
    active: number;
    disabled: number;
    expired: number;
    plans: Array<{ plan: string; count: number }>;
  };
  users: { tenant_users: number; system_users: number };
  today: {
    conversations: number;
    errors: number;
    error_rate: number;
    cost: number;
    total_tokens: number;
  };
  trend: Array<{ date: string; conversations: number; cost: number; errors: number }>;
  over_budget: Array<{ tenant_id: string; code: string; used: number; limit: number }>;
}

describe('GET /api/v1/system/stats · 平台方总览', () => {
  let http: AllHttp;

  beforeAll(async () => {
    http = await allHttpFromTokensFile();
  });

  it('200 + 结构完整（租户 / 用户 / 今日 / 趋势 / 超预算）', async () => {
    const r = await http.system.get<SystemStatsBody>('/stats');
    expect(r.status).toBe(200);
    const d = r.data;
    expect(typeof d.tenants.total).toBe('number');
    expect(typeof d.tenants.active).toBe('number');
    expect(typeof d.tenants.disabled).toBe('number');
    expect(typeof d.tenants.expired).toBe('number');
    expect(Array.isArray(d.tenants.plans)).toBe(true);
    expect(typeof d.users.tenant_users).toBe('number');
    expect(typeof d.users.system_users).toBe('number');
    expect(typeof d.today.conversations).toBe('number');
    expect(typeof d.today.error_rate).toBe('number');
    expect(typeof d.today.cost).toBe('number');
    expect(Array.isArray(d.trend)).toBe(true);
    expect(Array.isArray(d.over_budget)).toBe(true);
  });

  it('200 + 租户数对得上 /tenants 列表', async () => {
    const list = await http.system.get<{ tenants: Array<{ id: string }> }>('/tenants');
    const stats = await http.system.get<SystemStatsBody>('/stats');
    expect(stats.data.tenants.total).toBe(list.data.tenants.length);
    expect(stats.data.tenants.total).toBeGreaterThanOrEqual(2);
  });

  it('200 + 超预算列表里每一项都用量 > 预算（没超的不该出现）', async () => {
    const stats = await http.system.get<SystemStatsBody>('/stats');
    for (const t of stats.data.over_budget) {
      expect(t.limit).toBeGreaterThan(0);
      expect(t.used).toBeGreaterThan(t.limit);
    }
  });

  it('401 无 token', async () => {
    const r = await axios.get(`${BASE}/api/v1/system/stats`, { validateStatus: () => true });
    expect(r.status).toBe(401);
  });

  it('401 跨子系统防御：admin token 调 system 端点 → 401', async () => {
    const token = http.acmeAdmin.defaults.headers.authorization as string;
    const r = await axios.get(`${BASE}/api/v1/system/stats`, {
      headers: { authorization: token },
      validateStatus: () => true,
    });
    expect(r.status).toBe(401);
  });

  it('401 跨子系统防御：customer token 调 system 端点 → 401', async () => {
    const token = http.acmeCustomer.defaults.headers.authorization as string;
    const r = await axios.get(`${BASE}/api/v1/system/stats`, {
      headers: { authorization: token },
      validateStatus: () => true,
    });
    expect(r.status).toBe(401);
  });
});
