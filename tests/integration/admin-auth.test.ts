/**
 * tests/integration/admin-auth.test.ts
 * 对应 src/gateway/admin/auth-routes.ts（1 个端点：POST /login）
 * 详见 docs/18-测试流程规范.md §18.3
 *
 * （/me + /change-password 端点已删除，测试同步移除）
 */
import { describe, it, expect, beforeAll } from 'vitest';
import axios from 'axios';
import { apiBase,  allHttpFromTokensFile, loginAdmin, type AllHttp } from '../helpers';

const BASE = apiBase();

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
});
