/**
 * tests/integration/admin-audit.test.ts
 * 对应 src/gateway/admin/audit-routes.ts（GET /audit + GET /audit/actions）
 *
 * 覆盖：鉴权 / 跨租户隔离 / 系统级日志不外泄 / 筛选 / 分页
 */
import 'reflect-metadata';
import { describe, it, expect, beforeAll } from 'vitest';
import axios from 'axios';
import { apiBase,  allHttpFromTokensFile, adminHttp, readTokensFile, type AllHttp } from '../helpers';
import { getSequelize } from '../../src/db';
import { AuditLog } from '../../src/models';

const BASE = apiBase();

interface AuditRow {
  id: string;
  tenant_id: string;
  user_id: string | null;
  user_email: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  details: unknown;
  ip: string | null;
  created_at: string;
}

interface AuditListBody {
  logs: AuditRow[];
  pagination: { page: number; page_size: number; total: number; total_pages: number };
}

/** 系统级审计只有这两个 action（src/gateway/system/tenant-routes.ts 写的，tenant_id = NULL） */
const SYSTEM_ONLY_ACTIONS = ['TENANT_STATUS_CHANGE', 'TENANT_EXPIRES_CHANGE'];

describe('admin-audit-routes', () => {
  let http: AllHttp;
  let acmeAdminId: string;
  let acmeTenantId: string;
  let globexTenantId: string;

  beforeAll(async () => {
    http = await allHttpFromTokensFile();

    // 拿本租户 admin 的 user id + 两个租户的 tenant id（后面做隔离断言要用）
    const users = await http.acmeAdmin.get('/users');
    const me = (users.data as { users: Array<{ id: string; email: string }> }).users.find(
      (u) => u.email === 'admin@acme.test',
    );
    if (me === undefined) throw new Error('找不到 admin@acme.test');
    acmeAdminId = me.id;

    const tenants = await http.system.get('/tenants');
    const list = (tenants.data as { tenants: Array<{ id: string; code: string }> }).tenants;
    const acme = list.find((t) => t.code === 'acme');
    const globex = list.find((t) => t.code === 'globex');
    if (acme === undefined || globex === undefined) throw new Error('找不到 acme / globex 租户');
    acmeTenantId = acme.id;
    globexTenantId = globex.id;
  });

  describe('鉴权', () => {
    it('401 无 token', async () => {
      const r = await axios.get(`${BASE}/api/v1/admin/audit`, { validateStatus: () => true });
      expect(r.status).toBe(401);
    });

    it('401 token 非法', async () => {
      const r = await axios.get(`${BASE}/api/v1/admin/audit`, {
        headers: { authorization: 'Bearer not-a-jwt' },
        validateStatus: () => true,
      });
      expect(r.status).toBe(401);
    });

    it('401 customer token（角色不够）', async () => {
      const tokens = await readTokensFile();
      const cust = adminHttp(tokens.acmeCustomer);
      const r = await cust.get('/audit', { validateStatus: () => true });
      expect(r.status).toBe(401);
    });

    it('401 customer token 打 /audit/actions 也不行', async () => {
      const tokens = await readTokensFile();
      const cust = adminHttp(tokens.acmeCustomer);
      const r = await cust.get('/audit/actions', { validateStatus: () => true });
      expect(r.status).toBe(401);
    });
  });

  describe('列表 · 基本', () => {
    it('200 + 返回 logs + pagination', async () => {
      const r = await http.acmeAdmin.get('/audit');
      expect(r.status).toBe(200);
      const body = r.data as AuditListBody;
      expect(Array.isArray(body.logs)).toBe(true);
      expect(body.pagination.page).toBe(1);
      expect(body.pagination.page_size).toBe(20);
      expect(body.pagination.total).toBeGreaterThanOrEqual(0);
      expect(body.pagination.total_pages).toBe(
        Math.ceil(body.pagination.total / body.pagination.page_size),
      );
    });

    it('200 /audit/actions 返回操作类型清单', async () => {
      const r = await http.acmeAdmin.get('/audit/actions');
      expect(r.status).toBe(200);
      const actions = (r.data as { actions: string[] }).actions;
      expect(Array.isArray(actions)).toBe(true);
      // 只可能是本租户出现过的 action
      for (const a of actions) {
        expect(typeof a).toBe('string');
      }
    });

    it('400 page 参数非法', async () => {
      const r = await http.acmeAdmin.get('/audit', {
        params: { page: 'abc' },
        validateStatus: () => true,
      });
      expect(r.status).toBe(400);
    });
  });

  describe('跨租户隔离', () => {
    it('acme admin 只看得到 acme 的行', async () => {
      const r = await http.acmeAdmin.get('/audit', { params: { page_size: 100 } });
      const body = r.data as AuditListBody;
      expect(body.logs.length).toBeGreaterThan(0);
      for (const row of body.logs) {
        expect(row.tenant_id).toBe(acmeTenantId);
      }
    });

    it('globex admin 只看得到 globex 的行', async () => {
      const r = await http.globAdmin.get('/audit', { params: { page_size: 100 } });
      const body = r.data as AuditListBody;
      for (const row of body.logs) {
        expect(row.tenant_id).toBe(globexTenantId);
      }
    });

    it('globex 产生的审计行 acme 看不到', async () => {
      // globex 建个评测集 → 写一条 EVALUATION_DATASET_CREATED
      const created = await http.globAdmin.post(
        '/evaluation/datasets',
        {
          name: `audit-isolation-${Date.now()}`,
          items: [{ question: '跨租户隔离测试题' }],
        },
        { validateStatus: () => true },
      );
      expect(created.status).toBe(201);
      const globexDatasetId = (created.data as { id: string }).id;

      // globex 自己看得到
      const own = await http.globAdmin.get('/audit', {
        params: { action: 'EVALUATION_DATASET_CREATED', page_size: 100 },
      });
      const ownIds = (own.data as AuditListBody).logs.map((x) => x.resource_id);
      expect(ownIds).toContain(globexDatasetId);

      // acme 看不到：同 action 的行里没有这一条
      const other = await http.acmeAdmin.get('/audit', {
        params: { action: 'EVALUATION_DATASET_CREATED', page_size: 100 },
      });
      const otherIds = (other.data as AuditListBody).logs.map((x) => x.resource_id);
      expect(otherIds).not.toContain(globexDatasetId);

      // 清理
      await http.globAdmin.delete(`/evaluation/datasets/${globexDatasetId}`);
    });
  });

  describe('系统级日志（tenant_id 为空）不外泄给租户 admin', () => {
    it('平台方改租户到期时间 → 租户 admin 看不到这条', async () => {
      // 平台方操作：写一条 tenant_id = NULL 的 TENANT_EXPIRES_CHANGE
      // expires_at 传 null（本来就是 null）—— 状态不变，只为产生一条系统级审计
      const patched = await http.system.patch(
        `/tenants/${acmeTenantId}/expires_at`,
        { expires_at: null },
        { validateStatus: () => true },
      );
      expect(patched.status).toBe(200);

      // 先确认这条系统级记录真的落库了（不然断言会空过）
      const sysRows = await AuditLog.findAll({
        where: { tenant_id: null, action: 'TENANT_EXPIRES_CHANGE' },
        limit: 1,
        attributes: ['id', 'action', 'tenant_id'],
      });
      expect(sysRows.length).toBe(1);
      expect(sysRows[0]?.tenant_id).toBeNull();

      // 租户 admin 的列表里不能出现
      const list = await http.acmeAdmin.get('/audit', { params: { page_size: 100 } });
      const body = list.data as AuditListBody;
      expect(body.logs.some((x) => x.action === 'TENANT_EXPIRES_CHANGE')).toBe(false);
      for (const row of body.logs) {
        expect(row.tenant_id).toBe(acmeTenantId);
      }

      // 操作类型清单里也不能出现
      const acts = await http.acmeAdmin.get('/audit/actions');
      const actionList = (acts.data as { actions: string[] }).actions;
      for (const a of SYSTEM_ONLY_ACTIONS) {
        expect(actionList).not.toContain(a);
      }
    });
  });

  describe('筛选', () => {
    it('按 action 筛：出来的行 action 全对得上', async () => {
      // 造一条确定存在的记录
      const created = await http.acmeAdmin.post(
        '/evaluation/datasets',
        { name: `audit-filter-${Date.now()}`, items: [{ question: '筛选测试题' }] },
        { validateStatus: () => true },
      );
      expect(created.status).toBe(201);
      const datasetId = (created.data as { id: string }).id;

      const r = await http.acmeAdmin.get('/audit', {
        params: { action: 'EVALUATION_DATASET_CREATED', page_size: 100 },
      });
      const body = r.data as AuditListBody;
      expect(body.logs.length).toBeGreaterThan(0);
      for (const row of body.logs) {
        expect(row.action).toBe('EVALUATION_DATASET_CREATED');
      }
      expect(body.logs.map((x) => x.resource_id)).toContain(datasetId);

      await http.acmeAdmin.delete(`/evaluation/datasets/${datasetId}`);
    });

    it('按 action 筛：查一个不存在的 action → 空列表', async () => {
      const r = await http.acmeAdmin.get('/audit', {
        params: { action: '__NO_SUCH_ACTION__' },
      });
      const body = r.data as AuditListBody;
      expect(body.logs).toEqual([]);
      expect(body.pagination.total).toBe(0);
    });

    it('按 user_id 筛：出来的行 user_id 全对得上', async () => {
      const r = await http.acmeAdmin.get('/audit', {
        params: { user_id: acmeAdminId, page_size: 100 },
      });
      const body = r.data as AuditListBody;
      expect(body.logs.length).toBeGreaterThan(0);
      for (const row of body.logs) {
        expect(row.user_id).toBe(acmeAdminId);
        // 本租户的操作者应该是租户用户，邮箱能查到
        expect(row.user_email).toBe('admin@acme.test');
      }
    });

    it('按 user_id 筛：换个不存在的 id → 空列表', async () => {
      const r = await http.acmeAdmin.get('/audit', {
        params: { user_id: '__no_such_user__' },
      });
      const body = r.data as AuditListBody;
      expect(body.logs).toEqual([]);
    });

    it('按时间筛：from 在未来 → 空；to 在过去 → 空', async () => {
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const past = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();

      const byFrom = await http.acmeAdmin.get('/audit', { params: { from: future } });
      expect((byFrom.data as AuditListBody).logs).toEqual([]);

      const byTo = await http.acmeAdmin.get('/audit', { params: { to: past } });
      expect((byTo.data as AuditListBody).logs).toEqual([]);
    });

    it('按时间筛：宽区间能查到刚写的记录', async () => {
      const created = await http.acmeAdmin.post(
        '/evaluation/datasets',
        { name: `audit-time-${Date.now()}`, items: [{ question: '时间筛选测试题' }] },
        { validateStatus: () => true },
      );
      expect(created.status).toBe(201);
      const datasetId = (created.data as { id: string }).id;

      const from = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const to = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const r = await http.acmeAdmin.get('/audit', {
        params: { action: 'EVALUATION_DATASET_CREATED', from, to, page_size: 100 },
      });
      const body = r.data as AuditListBody;
      expect(body.logs.map((x) => x.resource_id)).toContain(datasetId);

      await http.acmeAdmin.delete(`/evaluation/datasets/${datasetId}`);
    });
  });

  describe('分页', () => {
    it('page_size 生效 + total 对得上', async () => {
      const r = await http.acmeAdmin.get('/audit', { params: { page: 1, page_size: 3 } });
      const body = r.data as AuditListBody;
      expect(body.logs.length).toBeLessThanOrEqual(3);
      expect(body.pagination.page_size).toBe(3);
      expect(body.pagination.page).toBe(1);
      expect(body.pagination.total).toBeGreaterThan(3);
      expect(body.pagination.total_pages).toBe(Math.ceil(body.pagination.total / 3));
    });

    it('翻页拿到不同的行', async () => {
      const p1 = await http.acmeAdmin.get('/audit', { params: { page: 1, page_size: 5 } });
      const p2 = await http.acmeAdmin.get('/audit', { params: { page: 2, page_size: 5 } });
      const b1 = p1.data as AuditListBody;
      const b2 = p2.data as AuditListBody;
      expect(b1.logs.length).toBe(5);
      expect(b2.logs.length).toBe(5);
      const ids1 = b1.logs.map((x) => x.id);
      const ids2 = b2.logs.map((x) => x.id);
      // 两页不重叠
      expect(ids1.filter((id) => ids2.includes(id))).toEqual([]);
    });

    it('超出范围的页 → 空列表，不报错', async () => {
      const r = await http.acmeAdmin.get('/audit', { params: { page: 99999, page_size: 10 } });
      expect(r.status).toBe(200);
      expect((r.data as AuditListBody).logs).toEqual([]);
    });

    it('page_size 超上限 → 400', async () => {
      const r = await http.acmeAdmin.get('/audit', {
        params: { page_size: 1000 },
        validateStatus: () => true,
      });
      expect(r.status).toBe(400);
    });
  });
});
