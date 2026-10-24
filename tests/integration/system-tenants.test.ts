/**
 * tests/integration/system-tenants.test.ts
 * 对应 src/gateway/system/tenant-routes.ts（7 个端点）
 * 详见 docs/18-测试流程规范.md §18.3
 */
import { describe, it, expect, beforeAll } from 'vitest';
import axios from 'axios';
import { apiBase,  allHttpFromTokensFile, type AllHttp } from '../helpers';

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

    it('400 new_password < 8 字符', async () => {
      const r = await http.system.post(
        `/tenants/${acmeId}/admin/reset-password`,
        { new_password: 'short' },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(400);
    });
  });
});
