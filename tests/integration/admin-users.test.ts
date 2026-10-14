/**
 * tests/integration/admin-users.test.ts
 * 对应 src/gateway/admin/user-routes.ts（4 个端点）
 * 详见 docs/18-测试流程规范.md §18.3
 */
import { describe, it, expect, beforeAll } from 'vitest';
import axios from 'axios';
import { allHttpFromTokensFile, type AllHttp } from '../helpers';

const BASE = `http://localhost:${process.env.PORT ?? '3000'}`;

describe('admin-users-routes', () => {
  let http: AllHttp;

  beforeAll(async () => {
    http = await allHttpFromTokensFile();
  });

  describe('GET /users · 列用户', () => {
    it('200 + 含 admin/customer', async () => {
      const r = await http.acmeAdmin.get('/users');
      expect(r.status).toBe(200);
      const emails = (r.data as { users: Array<{ email: string }> }).users.map((u) => u.email);
      expect(emails).toContain('admin@acme.test');
      expect(emails).toContain('alice@acme.test');
    });

    it('401 无 token', async () => {
      const r = await axios.get(`${BASE}/api/v1/admin/users`, { validateStatus: () => true });
      expect(r.status).toBe(401);
    });
  });

  describe('POST /users · 建用户', () => {
    it('201 + 建 customer', async () => {
      const email = `test-customer-${Date.now()}@acme.test`;
      const r = await http.acmeAdmin.post(
        '/users',
        { email, password: 'Pass-12345678', role: 'customer' },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(201);
      expect((r.data as { email: string }).email).toBe(email);
      // 清理：删掉
      const id = (r.data as { id: string }).id;
      await http.acmeAdmin.delete(`/users/${id}`);
    });

    it('400 邮箱已存在', async () => {
      const r = await http.acmeAdmin.post(
        '/users',
        { email: 'alice@acme.test', password: 'Pass-12345678', role: 'customer' },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(400);
    });

    it('400 password < 8 字符', async () => {
      const r = await http.acmeAdmin.post(
        '/users',
        { email: `x-${Date.now()}@acme.test`, password: 'short', role: 'customer' },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(400);
    });
  });

  describe('PATCH /users/:id · 改用户', () => {
    it('200 重置密码', async () => {
      // 先找一个 customer id
      const list = await http.acmeAdmin.get('/users');
      const target = (list.data as { users: Array<{ id: string; email: string }> }).users.find(
        (u) => u.email === 'alice@acme.test',
      );
      const id = target?.id;
      if (id === undefined) throw new Error('alice@acme.test 不存在');

      const r = await http.acmeAdmin.patch(
        `/users/${id}`,
        { password: 'NewPass-12345678' },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(200);
      // 还原
      await http.acmeAdmin.patch(`/users/${id}`, { password: 'AcmeCustomer-123!' });
    });

    it('404 不存在 id', async () => {
      const r = await http.acmeAdmin.patch(
        '/users/__no_such_id__',
        { email: 'x@y.test' },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(404);
    });
  });

  describe('DELETE /users/:id · 删用户', () => {
    it('400 不能删除自己', async () => {
      // /me 拿自己 id
      const me = await http.acmeAdmin.get('/me');
      const id = (me.data as { id: string }).id;
      const r = await http.acmeAdmin.delete(`/users/${id}`, { validateStatus: () => true });
      expect(r.status).toBe(400);
    });

    it('204 删刚建的测试用户', async () => {
      const email = `to-delete-${Date.now()}@acme.test`;
      const created = await http.acmeAdmin.post(
        '/users',
        { email, password: 'Pass-12345678', role: 'customer' },
        { validateStatus: () => true },
      );
      const id = (created.data as { id: string }).id;
      const r = await http.acmeAdmin.delete(`/users/${id}`, { validateStatus: () => true });
      expect(r.status).toBe(204);
    });

    it('404 不存在 id', async () => {
      const r = await http.acmeAdmin.delete('/users/__no_such_id__', {
        validateStatus: () => true,
      });
      expect(r.status).toBe(404);
    });
  });

  describe('跨租户防御', () => {
    it('acme admin 看不到 globex 用户', async () => {
      const r = await http.acmeAdmin.get('/users');
      const emails = (r.data as { users: Array<{ email: string }> }).users.map((u) => u.email);
      expect(emails).not.toContain('admin@globex.test');
      expect(emails).not.toContain('bob@globex.test');
    });
  });
});
