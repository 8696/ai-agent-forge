/**
 * tests/integration/auth-me-change-password.test.ts
 * A4 · 三层登录 —— `/me` 与 `/change-password` 端点 + 「必须先改密」闸门
 *
 * 对应 src/gateway/{admin,customer,system}/auth-routes.ts
 *        src/gateway/password-change-gate.ts
 *        src/services/change-password.ts
 *
 * ⚠️ **回归**：这两个端点之前被删过（注释写着「前端未用」），
 *    结果是 A4 的 19 个验收用例缺了 6 个，而且 `must_change_password`
 *    这个字段**从建表起就没人消费** ——
 *    平台方重置租户 admin 密码后，用户拿着临时密码长期用下去，
 *    没人被要求改。
 *
 * 前置条件：后端起在 3099（NODE_ENV=test PORT=3099 tsx src/server.ts）
 * 跑在别的端口上时用 API_BASE=http://localhost:<port> 覆盖。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Op } from 'sequelize';
import axios from 'axios';
import { getSequelize } from '../../src/db';
import { Tenant, User } from '../../src/models';
import { hashPassword } from '../../src/lib/password';

const TEST_EMAIL = 'must-change-password@acme.test';
const OLD_PASSWORD = 'OldPass-123!';
const NEW_PASSWORD = 'NewPass-456!';

function apiBase(): string {
  return process.env.API_BASE ?? `http://localhost:${process.env.PORT ?? '3099'}`;
}

describe('A4 · /me 与 /change-password + 强制改密闸门', () => {
  let tenantId: string;
  let createdUserId: string | null = null;

  beforeAll(async () => {
    getSequelize();
    const tenant = await Tenant.findOne({ where: { code: 'acme' } });
    expect(tenant).not.toBeNull();
    tenantId = tenant!.id;

    // 用一个**专门的**测试账号，不动种子账号的密码
    // （改了种子密码会让后面所有用 fixtures 登录的测试全挂）
    const existing = await User.findOne({ where: { tenant_id: tenantId, email: TEST_EMAIL } });
    if (existing !== null) {
      await existing.destroy();
    }
    const row = await User.create({
      tenant_id: tenantId,
      email: TEST_EMAIL,
      password_hash: await hashPassword(OLD_PASSWORD),
      role: 'admin',
      must_change_password: true,
    });
    createdUserId = row.id;
  });

  afterAll(async () => {
    if (createdUserId !== null) {
      await User.destroy({ where: { id: createdUserId } });
    }
  });

  const login = async (): Promise<{ token: string; user: { must_change_password?: boolean } }> => {
    const res = await axios.post(
      `${apiBase()}/api/v1/admin/login`,
      { email: TEST_EMAIL, password: OLD_PASSWORD, tenant_code: 'acme' },
      { validateStatus: () => true },
    );
    expect(res.status).toBe(200);
    return res.data as { token: string; user: { must_change_password?: boolean } };
  };

  const adminGet = (token: string, path: string): Promise<{ status: number; data: unknown }> =>
    axios
      .get(`${apiBase()}/api/v1/admin${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        validateStatus: () => true,
      })
      .then((r) => ({ status: r.status, data: r.data }));

  it('登录响应里带上 user.must_change_password（前端在等这个字段）', async () => {
    const { user } = await login();
    expect(user.must_change_password).toBe(true);
  });

  it('GET /me 能查到当前登录者', async () => {
    const { token } = await login();
    const res = await adminGet(token, '/me');
    expect(res.status).toBe(200);
    const body = res.data as { user: { email: string; role: string; tenant_id: string } };
    expect(body.user.email).toBe(TEST_EMAIL);
    expect(body.user.role).toBe('admin');
    expect(body.user.tenant_id).toBe(tenantId);
  });

  it('被要求改密时，除 /me 和 /change-password 外一律 403', async () => {
    const { token } = await login();
    const res = await adminGet(token, '/users');
    // 403 而不是 401 —— 401 会让前端以为「登录过期」把人踢回登录页
    expect(res.status).toBe(403);
  });

  it('旧密码不对 → 401', async () => {
    const { token } = await login();
    const res = await axios.post(
      `${apiBase()}/api/v1/admin/change-password`,
      { old_password: '不对的密码', new_password: NEW_PASSWORD },
      { headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true },
    );
    expect(res.status).toBe(401);
  });

  it('改密成功 → 返回一枚新 token，闸门随即放开', async () => {
    const { token } = await login();

    const res = await axios.post(
      `${apiBase()}/api/v1/admin/change-password`,
      { old_password: OLD_PASSWORD, new_password: NEW_PASSWORD },
      { headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true },
    );
    expect(res.status).toBe(200);
    const body = res.data as { ok: boolean; token?: string };
    expect(body.ok).toBe(true);
    expect(typeof body.token).toBe('string');

    // 新 token 不带「必须改密」标志 → 正常业务端点放行
    const after = await adminGet(body.token as string, '/users');
    expect(after.status).toBe(200);

    // 旧 token 还带着标志 → 仍然被挡（前端要替换 token 就是这个原因）
    const stale = await adminGet(token, '/users');
    expect(stale.status).toBe(403);

    // 标志本身也清掉了
    const row = await User.findOne({ where: { id: createdUserId } });
    expect(row?.must_change_password).toBe(false);
  });

  it('新密码能登进去，旧密码登不进去', async () => {
    const res = await axios.post(
      `${apiBase()}/api/v1/admin/login`,
      { email: TEST_EMAIL, password: NEW_PASSWORD, tenant_code: 'acme' },
      { validateStatus: () => true },
    );
    expect(res.status).toBe(200);
    const body = res.data as { user: { must_change_password?: boolean } };
    expect(body.user.must_change_password).toBe(false);

    const old = await axios.post(
      `${apiBase()}/api/v1/admin/login`,
      { email: TEST_EMAIL, password: OLD_PASSWORD, tenant_code: 'acme' },
      { validateStatus: () => true },
    );
    expect(old.status).toBe(401);
  });

  it('改密后这个账号的审计日志里有 PASSWORD_CHANGED（密码不进 details）', async () => {
    const { AuditLog } = await import('../../src/models');
    const row = await AuditLog.findOne({
      where: { user_id: createdUserId, action: 'PASSWORD_CHANGED' },
      order: [['created_at', 'DESC']],
    });
    expect(row).not.toBeNull();
    const details = JSON.stringify(row?.details ?? {});
    expect(details).not.toContain(OLD_PASSWORD);
    expect(details).not.toContain(NEW_PASSWORD);
  });

  it('清理：把测试账号从库里带走', async () => {
    await User.destroy({ where: { tenant_id: tenantId, email: TEST_EMAIL } });
    const left = await User.count({ where: { email: TEST_EMAIL } });
    expect(left).toBe(0);
    createdUserId = null;
    // 顺手确认没有别的残留
    const strays = await User.count({ where: { email: { [Op.like]: '%must-change-password%' } } });
    expect(strays).toBe(0);
  });
});
