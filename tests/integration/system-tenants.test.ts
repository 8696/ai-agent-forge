/**
 * tests/integration/system-tenants.test.ts
 * 对应 src/gateway/system/tenant-routes.ts（7 个端点）
 * 详见 docs/12-d-需求-运维稳定.md §D6
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import axios from 'axios';
import { apiBase, allHttpFromTokensFile, readTokensFile, type AllHttp } from '../helpers';
import { AuditLog, Tenant, User } from '../../src/models';

const BASE = apiBase();

describe('system-tenants-routes', () => {
  let http: AllHttp;
  let acmeId = '';

  beforeAll(async () => {
    http = await allHttpFromTokensFile();
    const list = await http.system.get('/tenants');
    const acme = (list.data as { tenants: Array<{ id: string; code: string }> }).tenants.find(
      (t) => t.code === 'acme',
    );
    acmeId = acme?.id ?? '';
  });

  describe('POST /tenants · 建租户', () => {
    it('400 code 不符合小写数字中划线规则', async () => {
      const r = await http.system.post(
        '/tenants',
        {
          code: 'BAD CODE',
          name: 'X',
          admin_email: 'a@b.test',
          admin_password: 'Pass-12345678',
        },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(400);
    });

    // A2 验收：「code 重复提交 → 返回 400「租户号已被使用」」
    // 2026-10-26 补 —— 这条以前**一次都没被测过**（「租户号已被使用」这个字符串
    // 全仓只出现在 src/gateway/system/tenant-routes.ts 里）。
    it('400 code 已被使用 → 「租户号已被使用」', async () => {
      const r = await http.system.post(
        '/tenants',
        {
          code: 'acme', // 种子数据里已存在
          name: '重复的租户号',
          admin_email: 'dup@acme.test',
          admin_password: 'Pass-12345678',
        },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.data)).toContain('租户号已被使用');
    });

    // A2 验收：「跨子系统鉴权：用非 system 角色的 token 调用 → 401」
    it('401 用 admin 的 token 建租户（跨子系统）', async () => {
      // ⚠️ 必须用**裸 axios**：`http.acmeAdmin` 的 baseURL 锁死在 /api/v1/admin，
      //    拿它打 /tenants 会打到 /api/v1/admin/tenants（那个路由不存在 → 404，
      //    不是鉴权失败）。要打 system 的端点就得自己拼完整 URL。
      const { acmeAdmin } = await readTokensFile();
      const r = await axios.post(
        `${BASE}/api/v1/system/tenants`,
        {
          code: 'cross-subsystem-probe',
          name: '跨子系统探针',
          admin_email: 'x@y.test',
          admin_password: 'Pass-12345678',
        },
        { headers: { authorization: `Bearer ${acmeAdmin}` }, validateStatus: () => true },
      );
      expect(r.status).toBe(401);
    });

    it('401 无 token', async () => {
      const r = await axios.post(
        `${BASE}/api/v1/system/tenants`,
        {
          code: 'x',
          name: 'X',
          admin_email: 'a@b.test',
          admin_password: 'Pass-12345678',
        },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(401);
    });
  });

  describe('GET /tenants · 列租户', () => {
    it('200 + 包含 acme/globex', async () => {
      const r = await http.system.get('/tenants');
      expect(r.status).toBe(200);
      const codes = (r.data as { tenants: Array<{ code: string }> }).tenants.map((t) => t.code);
      expect(codes).toContain('acme');
      expect(codes).toContain('globex');
    });

    it('200 + F2 字段 status/expires_at 在', async () => {
      const r = await http.system.get('/tenants');
      const acme = (r.data as { tenants: Array<{ code: string; status: string; expires_at: Date | null }> }).tenants.find(
        (t) => t.code === 'acme',
      );
      expect(acme?.status).toBe('active');
    });
  });

  describe('GET /tenants/:id · 单租户', () => {
    it('200 + acme 详情', async () => {
      const r = await http.system.get(`/tenants/${acmeId}`);
      expect(r.status).toBe(200);
      expect((r.data as { code: string }).code).toBe('acme');
      expect((r.data as { admin: { email: string } | null }).admin?.email).toBe('admin@acme.test');
    });

    it('404 不存在的 id', async () => {
      const r = await http.system.get('/tenants/__no_such_id__', { validateStatus: () => true });
      expect(r.status).toBe(404);
    });
  });

  describe('PATCH /tenants/:id · 改基本资料', () => {
    it('200 改 name', async () => {
      const r = await http.system.patch(
        `/tenants/${acmeId}`,
        { name: 'Acme Corp (Test)' },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(200);
      expect((r.data as { name: string }).name).toBe('Acme Corp (Test)');
    });

    it('400 非法 plan 枚举', async () => {
      const r = await http.system.patch(
        `/tenants/${acmeId}`,
        { plan: 'enterprise-plus' },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(400);
    });
  });

  describe('PATCH /tenants/:id/expires_at · F2 改到期', () => {
    it('200 设置 + 清空', async () => {
      const r1 = await http.system.patch(
        `/tenants/${acmeId}/expires_at`,
        { expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString() },
        { validateStatus: () => true },
      );
      expect(r1.status).toBe(200);
      const r2 = await http.system.patch(
        `/tenants/${acmeId}/expires_at`,
        { expires_at: null },
        { validateStatus: () => true },
      );
      expect(r2.status).toBe(200);
    });
  });

  describe('PATCH /tenants/:id/status · F2 启停', () => {
    it('200 active → active（幂等）', async () => {
      const r = await http.system.patch(
        `/tenants/${acmeId}/status`,
        { status: 'active' },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(200);
    });

    it('400 status 非法值', async () => {
      const r = await http.system.patch(
        `/tenants/${acmeId}/status`,
        { status: 'paused' },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(400);
    });
  });

  describe('POST /tenants/:id/admin/reset-password · F1 重置密码', () => {
    it('200 重置 admin 密码', async () => {
      const r = await http.system.post(
        `/tenants/${acmeId}/admin/reset-password`,
        { new_password: 'NewAdminPass-123' },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(200);
      // 重置完把密码还原成 seed 默认值，避免污染下次跑
      await http.system.post(`/tenants/${acmeId}/admin/reset-password`, {
        new_password: 'AcmeAdmin-123!',
      });
    });

    /**
     * ⚠️ **必须把 `must_change_password` 也复位**（2026-10-26 修）。
     *
     * 「重置密码」这个动作**本身**就会给该 admin 打上 `must_change_password=true` ——
     * 上面那次「还原密码」用的还是同一个端点，所以标记仍然是 true。
     *
     * 后果（很难查）：**后面所有测试文件都成片挂**。
     *  - 闸门 `assertPasswordChanged` 只放行 `/me` 和 `/change-password`，其余一律 **403**
     *  - 已经签好的 token 里 claim 是 undefined（登录时标记还是 false）→ **不受影响**
     *  - 但**任何在污染之后重新登录一次**的测试，拿到的 token 就带着 claim=true → 403
     *
     * 之所以「时好时坏」：**vitest 的测试文件顺序不稳定**（按耗时排），
     * 污染文件排在后面就没事，排在中间就雪崩。
     */
    afterAll(async () => {
      await User.update(
        { must_change_password: false },
        { where: { tenant_id: acmeId, role: 'admin' } },
      );
    });

    it('400 new_password < 8 字符', async () => {
      const r = await http.system.post(
        `/tenants/${acmeId}/admin/reset-password`,
        { new_password: 'short' },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(400);
    });
  });

  /**
   * 平台方写操作补审计（2026-10-26）
   *
   * ⚠️ 以前**只有** F2 的两个 PATCH（改到期 / 改启停）写审计，
   *    建租户 / 改租户资料 / 重置租户 admin 密码这三条
   *    「影响全局」的路径一条都没记 —— 而租户后台建用户反而记了。
   *    这条测试锁住补上的三条。
   */
  describe('平台方写操作写审计', () => {
    const code = `audit-probe-${Date.now()}`;
    let tenantId = '';

    afterAll(async () => {
      if (tenantId !== '') {
        // users.tenant_id 是 ON DELETE CASCADE —— 删租户连带删掉它的 admin
        await Tenant.destroy({ where: { id: tenantId } });
      }
    });

    it('建租户 → TENANT_CREATED（系统级日志，tenant_id 为 NULL）', async () => {
      const r = await http.system.post(
        '/tenants',
        {
          code,
          name: '审计探针租户',
          admin_email: `admin-${code}@probe.test`,
          admin_password: 'Pass-12345678',
        },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(201);
      tenantId = (r.data as { tenant: { id: string } }).tenant.id;

      const row = await AuditLog.findOne({
        where: { action: 'TENANT_CREATED', resource_id: tenantId },
        order: [['created_at', 'DESC']],
      });
      expect(row).not.toBeNull();
      // 系统级日志：tenant_id 为空（平台方不属于任何租户）
      expect(row?.tenant_id).toBeNull();
      const details = JSON.stringify(row?.details ?? {});
      // 记了租户信息，但**绝不记密码**
      expect(details).toContain(code);
      expect(details).not.toContain('Pass-12345678');
    });

    it('改租户 name/plan → TENANT_UPDATED', async () => {
      const r = await http.system.patch(
        `/tenants/${tenantId}`,
        { name: '改名后的探针租户' },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(200);

      const row = await AuditLog.findOne({
        where: { action: 'TENANT_UPDATED', resource_id: tenantId },
        order: [['created_at', 'DESC']],
      });
      expect(row).not.toBeNull();
      const details = JSON.stringify(row?.details ?? {});
      expect(details).toContain('改名后的探针租户');
    });

    it('重置租户 admin 密码 → TENANT_ADMIN_PASSWORD_RESET（密码不进 details）', async () => {
      const r = await http.system.post(
        `/tenants/${tenantId}/admin/reset-password`,
        { new_password: 'Brand-New-Pass-999' },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(200);

      const row = await AuditLog.findOne({
        where: { action: 'TENANT_ADMIN_PASSWORD_RESET', resource_id: tenantId },
        order: [['created_at', 'DESC']],
      });
      expect(row).not.toBeNull();
      const details = JSON.stringify(row?.details ?? {});
      expect(details).not.toContain('Brand-New-Pass-999');
    });
  });
});
