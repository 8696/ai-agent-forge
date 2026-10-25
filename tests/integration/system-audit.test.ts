/**
 * F1/D5 · 平台方的审计日志（跨租户）—— docs/12-e-需求-业务接入与平台运营.md
 *
 * 平台方视角的审计日志端点（GET /api/v1/system/audit）：
 *   - 能看到**全部租户**的日志
 *   - 还能看到**系统级日志**（tenant_id 为空 —— 平台方改租户启停 / 到期时间那类）
 *   - 租户 admin 打过来 → 401（命名空间隔离）
 *
 * ⚠️ 跟租户后台的 /admin/audit 是**两个视角**，别混：
 *   租户 admin 只看得到本租户的（`tenant_id = 'x'`，SQL 里 NULL = 'x' 恒为 false）。
 */
import { describe, it, expect } from 'vitest';
import { systemHttp, apiBase, readTokensFile } from '../helpers';
import axios from 'axios';

describe('F1 · 平台方审计日志（跨租户）', () => {
  it('system 角色能拿到全部审计日志（含系统级）', async () => {
    const tokens = await readTokensFile();
    const http = systemHttp(tokens.system);
    const res = await http.get<{
      logs: Array<{
        id: string;
        tenant_id: string | null;
        user_email: string | null;
        action: string;
        created_at: string;
      }>;
      pagination: { total: number };
    }>('/audit', { params: { page_size: 50 } });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.data.logs)).toBe(true);
    expect(res.data.pagination.total).toBeGreaterThanOrEqual(0);
    for (const row of res.data.logs) {
      expect(typeof row.action).toBe('string');
      expect(typeof row.created_at).toBe('string');
    }
  });

  it('能按租户过滤', async () => {
    const tokens = await readTokensFile();
    const http = systemHttp(tokens.system);
    const tenantsRes = await http.get<{ tenants: Array<{ id: string; code: string }> }>('/tenants');
    const acme = tenantsRes.data.tenants.find((t) => t.code === 'acme');
    expect(acme).toBeDefined();

    const res = await http.get<{ logs: Array<{ tenant_id: string | null }> }>('/audit', {
      params: { tenant_id: acme?.id, page_size: 50 },
    });
    expect(res.status).toBe(200);
    // 过滤后不该出现别的租户的行，也不该出现系统级（tenant_id 为 null）的行
    for (const row of res.data.logs) {
      expect(row.tenant_id).toBe(acme?.id);
    }
  });

  it('操作类型清单端点可用', async () => {
    const tokens = await readTokensFile();
    const http = systemHttp(tokens.system);
    const res = await http.get<{ actions: string[] }>('/audit/actions');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data.actions)).toBe(true);
  });

  it('跨子系统防御：租户 admin token 打 system 端点 → 401', async () => {
    const tokens = await readTokensFile();
    // ⚠️ 不能用 adminHttp —— 它的 baseURL 是 /api/v1/admin，
    //    打 /audit 会落到 admin 命名空间（404），不是「鉴权挡住」。
    const res = await axios.get(`${apiBase()}/api/v1/system/audit`, {
      headers: { authorization: `Bearer ${tokens.acmeAdmin}` },
      validateStatus: () => true,
    });
    expect(res.status).toBe(401);
  });

  it('租户 admin 看不到系统级日志（跨租户隔离没被破）', async () => {
    const tokens = await readTokensFile();
    const adminRes = await axios.get(`${apiBase()}/api/v1/admin/audit`, {
      headers: { authorization: `Bearer ${tokens.acmeAdmin}` },
      params: { page_size: 100 },
    });
    expect(adminRes.status).toBe(200);
    const logs = adminRes.data.logs as Array<{ tenant_id: string | null }>;
    // 租户 admin 那边永远不该出现 tenant_id 为 null 的系统级日志
    expect(logs.every((r) => r.tenant_id !== null)).toBe(true);
  });
});
