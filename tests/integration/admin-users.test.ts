/**
 * tests/integration/admin-users.test.ts
 * 对应 src/gateway/admin/user-routes.ts（4 个端点）
 * 详见 docs/12-d-需求-运维稳定.md §D6
 */
import { describe, it, expect, beforeAll } from 'vitest';
import axios from 'axios';
import { apiBase,  allHttpFromTokensFile, type AllHttp } from '../helpers';

const BASE = apiBase();

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

    // A3 验收：「admin 创建 3 个 admin 角色用户（实际业务：不同 admin 共存）」
    // 2026-10-26 补 —— 这条以前只测了 role='customer'，
    // 「多 admin 共存」这个业务场景从未被端到端验证过。
    it('201 + 建 admin 角色用户（多 admin 共存）', async () => {
      const email = `test-admin-${Date.now()}@acme.test`;
      const r = await http.acmeAdmin.post(
        '/users',
        { email, password: 'Pass-12345678', role: 'admin' },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(201);
      const body = r.data as { id: string; email: string; role: string };
      expect(body.email).toBe(email);
      expect(body.role).toBe('admin');

      // 新建的 admin 能用 admin 入口登录（同租户号 + 不同邮箱）
      const login = await axios.post(
        `${BASE}/api/v1/admin/login`,
        { email, password: 'Pass-12345678', tenant_code: 'acme' },
        { validateStatus: () => true },
      );
      expect(login.status).toBe(200);

      // 清理：删掉
      await http.acmeAdmin.delete(`/users/${body.id}`);
    });

    it('400 role=agent 被拒（历史 ENUM 留位，不开放）', async () => {
      const r = await http.acmeAdmin.post(
        '/users',
        { email: `agent-${Date.now()}@acme.test`, password: 'Pass-12345678', role: 'agent' },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(400);
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
      // /me 已删除；用 /users 列表找到自己（登录的 admin 邮箱对应的 id 就是自己）
      const list = await http.acmeAdmin.get('/users');
      const me = (list.data as { users: Array<{ id: string; email: string }> }).users.find(
        (u) => u.email === 'admin@acme.test',
      );
      if (me === undefined) throw new Error('找不到 admin@acme.test');
      const r = await http.acmeAdmin.delete(`/users/${me.id}`, { validateStatus: () => true });
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

  // D5 的验收原文：「关键操作（建用户 / 改配置 / 租户启停 / 文档增删）→ audit_logs 有记录」
  // 建用户这一条以前是漏的 —— 补上以后必须有测试钉住，别再退回原样
  describe('审计留痕 · 用户写操作', () => {
    /** 取本租户某个 action 的审计记录（按时间倒序，第一条就是刚发生的） */
    const fetchAudit = async (action: string): Promise<
      Array<{ action: string; resource_type: string | null; resource_id: string | null; details: unknown }>
    > => {
      const r = await http.acmeAdmin.get(`/audit?action=${action}&page_size=10`);
      expect(r.status).toBe(200);
      return (r.data as { logs: Array<{ action: string; resource_type: string | null; resource_id: string | null; details: unknown }> })
        .logs;
    };

    it('建用户 → USER_CREATED', async () => {
      const email = `audit-created-${Date.now()}@acme.test`;
      const created = await http.acmeAdmin.post(
        '/users',
        { email, password: 'Pass-12345678', role: 'customer' },
        { validateStatus: () => true },
      );
      expect(created.status).toBe(201);
      const id = (created.data as { id: string }).id;

      const logs = await fetchAudit('USER_CREATED');
      const hit = logs.find((l) => l.resource_id === id);
      expect(hit, '建用户后应有 USER_CREATED 审计记录').toBeDefined();
      expect(hit?.resource_type).toBe('user');
      expect((hit?.details as { email: string }).email).toBe(email);
      // ⚠️ 密码绝不能进审计
      expect(JSON.stringify(hit?.details)).not.toContain('Pass-12345678');

      await http.acmeAdmin.delete(`/users/${id}`);
    });

    it('改用户 → USER_UPDATED（密码不进日志）', async () => {
      const email = `audit-updated-${Date.now()}@acme.test`;
      const created = await http.acmeAdmin.post(
        '/users',
        { email, password: 'Pass-12345678', role: 'customer' },
        { validateStatus: () => true },
      );
      const id = (created.data as { id: string }).id;

      const r = await http.acmeAdmin.patch(
        `/users/${id}`,
        { email: `renamed-${Date.now()}@acme.test`, password: 'Another-12345678' },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(200);

      const logs = await fetchAudit('USER_UPDATED');
      const hit = logs.find((l) => l.resource_id === id);
      expect(hit, '改用户后应有 USER_UPDATED 审计记录').toBeDefined();
      const details = hit?.details as {
        prev_email: string;
        email: string;
        email_changed: boolean;
        password_reset: boolean;
      };
      expect(details.email_changed).toBe(true);
      expect(details.password_reset).toBe(true);
      expect(details.prev_email).toBe(email);
      expect(JSON.stringify(hit?.details)).not.toContain('Another-12345678');

      await http.acmeAdmin.delete(`/users/${id}`);
    });

    it('删用户 → USER_DELETED', async () => {
      const email = `audit-deleted-${Date.now()}@acme.test`;
      const created = await http.acmeAdmin.post(
        '/users',
        { email, password: 'Pass-12345678', role: 'customer' },
        { validateStatus: () => true },
      );
      const id = (created.data as { id: string }).id;

      const r = await http.acmeAdmin.delete(`/users/${id}`, { validateStatus: () => true });
      expect(r.status).toBe(204);

      const logs = await fetchAudit('USER_DELETED');
      const hit = logs.find((l) => l.resource_id === id);
      expect(hit, '删用户后应有 USER_DELETED 审计记录').toBeDefined();
      expect((hit?.details as { email: string }).email).toBe(email);
    });

    it('新建的 action 出现在筛选下拉框的清单里', async () => {
      const r = await http.acmeAdmin.get('/audit/actions');
      expect(r.status).toBe(200);
      const actions = (r.data as { actions: string[] }).actions;
      expect(actions).toContain('USER_CREATED');
      expect(actions).toContain('USER_UPDATED');
      expect(actions).toContain('USER_DELETED');
    });
  });
});
