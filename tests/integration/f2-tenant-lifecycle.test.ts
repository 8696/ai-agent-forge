/**
 * F2 · 租户启停 / 到期 —— docs/12-e-需求-业务接入与平台运营.md §F2
 *
 * F2 的验收里明写着 9 条，其中这三条在 2026-10-25 之前**没有被测试锁住**：
 *   - 禁用 / 到期租户登录 → 401，且响应体与「邮箱或密码错误」**逐字段完全一致**
 *     （现有测试只断言了 401，没比对 body —— 哪天有人给禁用态换个文案，测试不会红）
 *   - 防自锁：禁用 `code='system'` 的初始租户 → 400
 *     （这条以前**永远触发不到** —— 平台方不自动建 code='system' 的租户，
 *       防御代码是一段没人能走到的分支）
 *   - 审计日志写 TENANT_STATUS_CHANGE / TENANT_EXPIRES_CHANGE
 *
 * ## 关于「系统初始租户」
 *
 * 本项目**没有**平台方自带的初始租户（平台方账号在 `system_users` 表，不挂租户）。
 * 但租户号 `system` 是合法租户号 —— 平台方自己建一个就叫「系统初始租户」，
 * 禁掉它就等于把平台自用的那个租户也停掉了。所以这条防御是**有前提才生效**的：
 * 前提成立时它必须拦住，不成立时它就是一段惰性代码。这里把前提造出来验证它。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Op } from 'sequelize';
import axios from 'axios';
import { allHttpFromTokensFile, apiBase, readTokensFile, type AllHttp } from '../helpers';
import { getSequelize } from '../../src/db';
import { AuditLog, Tenant, User } from '../../src/models';

const PROTECTED_CODE = 'system';
const NORMAL_CODE = 'f2-lifecycle-test';

describe('F2 · 租户启停 / 到期（端到端）', () => {
  let http: AllHttp;
  const createdCodes: string[] = [];

  const createTenant = async (
    code: string,
    extra: { plan?: string; expires_at?: string | null } = {},
  ): Promise<string> => {
    createdCodes.push(code);
    const res = await http.system.post(
      '/tenants',
      {
        code,
        name: `F2 测试租户 ${code}`,
        admin_email: `admin-${code}@test.local`,
        admin_password: 'TestPass-123!',
        ...extra,
      },
      { validateStatus: () => true },
    );
    expect(res.status).toBe(201);
    return code;
  };

  const tenantOf = async (code: string): Promise<Tenant> => {
    const t = await Tenant.findOne({ where: { code } });
    if (t === null) throw new Error(`租户 ${code} 不存在`);
    return t;
  };

  const loginAs = async (
    code: string,
    password: string,
  ): Promise<{ status: number; body: unknown }> => {
    const res = await http.acmeAdmin.post(
      '/login',
      { tenant_code: code, email: `admin-${code}@test.local`, password },
      { validateStatus: () => true },
    );
    return { status: res.status, body: res.data };
  };

  beforeAll(async () => {
    getSequelize();
    http = await allHttpFromTokensFile();
  });

  afterAll(async () => {
    if (createdCodes.length === 0) return;
    const tenants = await Tenant.findAll({ where: { code: { [Op.in]: createdCodes } } });
    const ids = tenants.map((t) => t.id);
    if (ids.length > 0) {
      await User.destroy({ where: { tenant_id: { [Op.in]: ids } } });
      await Tenant.destroy({ where: { id: { [Op.in]: ids } } });
    }
  });

  it('防自锁：禁用「系统初始租户」→ 400「不能禁用系统初始租户」', async () => {
    await createTenant(PROTECTED_CODE);
    const tenant = await tenantOf(PROTECTED_CODE);

    const res = await http.system.patch(
      `/tenants/${tenant.id}/status`,
      { status: 'disabled' },
      { validateStatus: () => true },
    );
    expect(res.status).toBe(400);
    expect(res.data.code).toBe('VALIDATION_ERROR');
    expect(String(res.data.message)).toContain('不能禁用系统初始租户');

    // 状态没变
    expect((await tenantOf(PROTECTED_CODE)).status).toBe('active');

    // 但改成 active 是允许的（只挡 disabled）
    const back = await http.system.patch(
      `/tenants/${tenant.id}/status`,
      { status: 'active' },
      { validateStatus: () => true },
    );
    expect(back.status).toBe(200);
  });

  it('禁用租户 → 登录 401，且响应体与「密码错误」逐字段完全一致', async () => {
    await createTenant(NORMAL_CODE);
    const tenant = await tenantOf(NORMAL_CODE);

    // 先记下「密码错」的响应体
    const wrongPassword = await loginAs(NORMAL_CODE, 'Totally-Wrong-123!');
    expect(wrongPassword.status).toBe(401);

    const disable = await http.system.patch(
      `/tenants/${tenant.id}/status`,
      { status: 'disabled' },
      { validateStatus: () => true },
    );
    expect(disable.status).toBe(200);

    // 密码正确但租户被禁用 → 401，响应体必须一模一样
    const disabled = await loginAs(NORMAL_CODE, 'TestPass-123!');
    expect(disabled.status).toBe(401);
    expect(disabled.body).toEqual(wrongPassword.body);
    expect(disabled.body).toEqual({ code: 'AUTH_ERROR', message: '邮箱或密码错误' });
  });

  it('到期租户 → 登录 401，响应体与「密码错误」完全一致', async () => {
    await createTenant('f2-expired-test');
    const tenant = await tenantOf('f2-expired-test');
    createdCodes.push('f2-expired-test');

    // 改一个已经过去的到期时间
    const past = new Date(Date.now() - 60_000).toISOString();
    const res = await http.system.patch(
      `/tenants/${tenant.id}/expires_at`,
      { expires_at: past },
      { validateStatus: () => true },
    );
    expect(res.status).toBe(200);

    const wrongPassword = await loginAs('f2-expired-test', 'Totally-Wrong-123!');
    const expired = await loginAs('f2-expired-test', 'TestPass-123!');
    expect(expired.status).toBe(401);
    expect(expired.body).toEqual(wrongPassword.body);
  });

  it('改回 active + 清空到期 → 立刻能登录（不用重启服务）', async () => {
    const tenant = await tenantOf(NORMAL_CODE);

    const active = await http.system.patch(
      `/tenants/${tenant.id}/status`,
      { status: 'active' },
      { validateStatus: () => true },
    );
    expect(active.status).toBe(200);
    const clear = await http.system.patch(
      `/tenants/${tenant.id}/expires_at`,
      { expires_at: null },
      { validateStatus: () => true },
    );
    expect(clear.status).toBe(200);

    const res = await loginAs(NORMAL_CODE, 'TestPass-123!');
    expect(res.status).toBe(200);
  });

  it('改启停 / 到期都写审计日志', async () => {
    const tenant = await tenantOf(NORMAL_CODE);
    const rows = await AuditLog.findAll({
      where: { action: { [Op.in]: ['TENANT_STATUS_CHANGE', 'TENANT_EXPIRES_CHANGE'] } },
      order: [['created_at', 'DESC']],
    });
    const forThisTenant = rows.filter((r) => r.resource_id === tenant.id);
    expect(forThisTenant.length).toBeGreaterThanOrEqual(2);
    expect(forThisTenant.map((r) => r.action)).toEqual(
      expect.arrayContaining(['TENANT_STATUS_CHANGE', 'TENANT_EXPIRES_CHANGE']),
    );
    // 系统级日志的 tenant_id 为空
    expect(forThisTenant[0]?.tenant_id).toBeNull();
  });

  it('列表返回值带 status + expires_at', async () => {
    const res = await http.system.get('/tenants', { validateStatus: () => true });
    expect(res.status).toBe(200);
    const list = res.data.tenants as Array<Record<string, unknown>>;
    const row = list.find((t) => t.code === NORMAL_CODE);
    expect(row).toBeDefined();
    expect(row).toHaveProperty('status');
    expect(row).toHaveProperty('expires_at');
  });

  it('跨子系统防御：admin token 调 system 端点 → 401', async () => {
    // ⚠️ 不能用 http.acmeAdmin —— 它的 baseURL 是 /api/v1/admin，
    //    打 /tenants 会落到 admin 命名空间（404），不是「鉴权挡住」。
    //    这里直接打 system 的完整 URL，验证的是「token 角色不对 → 401」。
    const tokens = await readTokensFile();
    const res = await axios.get(`${apiBase()}/api/v1/system/tenants`, {
      headers: { authorization: `Bearer ${tokens.acmeAdmin}` },
      validateStatus: () => true,
    });
    expect(res.status).toBe(401);
  });
});
