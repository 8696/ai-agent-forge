/**
 * tests/integration/customer-auth.test.ts
 * 对应 src/gateway/customer/auth-routes.ts（1 个端点：POST /login）
 * 详见 docs/12-d-需求-运维稳定.md §D6
 *
 * 注意：customer 子系统其他端点（/me / change-password / chat / sessions）已清空，
 * 所以这里只测 login。
 */
import { describe, it, expect } from 'vitest';
import axios from 'axios';
import { apiBase,  loginCustomer } from '../helpers';

const BASE = apiBase();

describe('customer-auth-routes', () => {
  describe('POST /api/v1/customer/login', () => {
    it('200 + JWT（acme customer）', async () => {
      const token = await loginCustomer('acme');
      expect(token).toMatch(/^eyJ/);
    });

    it('200 + JWT（globex customer）', async () => {
      const token = await loginCustomer('globex');
      expect(token).toMatch(/^eyJ/);
    });

    it('401 密码错', async () => {
      const r = await axios.post(
        `${BASE}/api/v1/customer/login`,
        { email: 'alice@acme.test', password: 'wrong', tenant_code: 'acme' },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(401);
    });

    it('401 租户 code 不存在', async () => {
      const r = await axios.post(
        `${BASE}/api/v1/customer/login`,
        { email: 'alice@acme.test', password: 'AcmeCustomer-123!', tenant_code: 'no-such-tenant' },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(401);
    });

    it('401 用 admin 账号登 customer 子系统（角色锁死）', async () => {
      const r = await axios.post(
        `${BASE}/api/v1/customer/login`,
        { email: 'admin@acme.test', password: 'AcmeAdmin-123!', tenant_code: 'acme' },
        { validateStatus: () => true },
      );
      // admin 角色在 customer 表里查不到 → 401
      expect(r.status).toBe(401);
    });

    it('400 tenant_code 不符合小写数字中划线规则', async () => {
      const r = await axios.post(
        `${BASE}/api/v1/customer/login`,
        { email: 'alice@acme.test', password: 'AcmeCustomer-123!', tenant_code: 'BAD_CODE' },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(400);
    });
  });

});
