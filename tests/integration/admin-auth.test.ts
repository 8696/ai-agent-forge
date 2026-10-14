/**
 * tests/integration/admin-auth.test.ts
 * 对应 src/gateway/admin/auth-routes.ts（3 个端点）
 * 详见 docs/18-测试流程规范.md §18.3
 */
import { describe, it, expect, beforeAll } from 'vitest';
import axios from 'axios';
import { allHttpFromTokensFile, loginAdmin, type AllHttp } from '../helpers';

const BASE = `http://localhost:${process.env.PORT ?? '3000'}`;

describe('admin-auth-routes', () => {
  let http: AllHttp;

  beforeAll(async () => {
    http = await allHttpFromTokensFile();
  });

  describe('POST /api/v1/admin/login', () => {
    it('200 + JWT（acme admin）', async () => {
      const token = await loginAdmin('acme');
      expect(token).toMatch(/^eyJ/);
    });

    it('200 + JWT（globex admin）', async () => {
      const token = await loginAdmin('globex');
      expect(token).toMatch(/^eyJ/);
    });

    it('401 密码错', async () => {
      const r = await axios.post(
        `${BASE}/api/v1/admin/login`,
        { email: 'admin@acme.test', password: 'wrong', tenant_code: 'acme' },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(401);
    });

    it('401 租户 code 不存在', async () => {
      const r = await axios.post(
        `${BASE}/api/v1/admin/login`,
        { email: 'admin@acme.test', password: 'AcmeAdmin-123!', tenant_code: 'no-such-tenant' },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(401);
    });

    it('400 tenant_code 不符合小写数字中划线规则', async () => {
      const r = await axios.post(
        `${BASE}/api/v1/admin/login`,
        { email: 'admin@acme.test', password: 'AcmeAdmin-123!', tenant_code: 'BAD_CODE' },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(400);
    });
  });

  describe('GET /api/v1/admin/me', () => {
    it('200 + 当前 admin', async () => {
      const r = await http.acmeAdmin.get('/me');
      expect(r.status).toBe(200);
      expect((r.data as { email: string }).email).toBe('admin@acme.test');
      expect((r.data as { role: string }).role).toBe('admin');
    });

    it('401 无 token', async () => {
      const r = await axios.get(`${BASE}/api/v1/admin/me`, { validateStatus: () => true });
      expect(r.status).toBe(401);
    });
  });

  describe('POST /api/v1/admin/change-password', () => {
    it('400 new_password < 8 字符', async () => {
      const r = await axios.post(
        `${BASE}/api/v1/admin/change-password`,
        { old_password: 'a', new_password: 'short' },
        {
          headers: { authorization: http.acmeAdmin.defaults.headers.authorization },
          validateStatus: () => true,
        },
      );
      expect(r.status).toBe(400);
    });

    it('401 无 token', async () => {
      const r = await axios.post(
        `${BASE}/api/v1/admin/change-password`,
        { old_password: 'a', new_password: 'NewPass-12345678' },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(401);
    });
  });
});
