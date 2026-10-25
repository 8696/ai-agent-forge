/**
 * A4 · 登录失败锁定 —— docs/12-a-需求-多租户与登录.md §A4
 *
 * A4 的验收里明写着三条端到端用例：
 *   - 5 次失败 → 锁定（DB 状态正确 + **正确密码也 401**）= 2 个用例
 *   - 成功后 failed_login_count 清零 = 1 个用例
 *
 * ⚠️ 2026-10-25 之前这三条**只有单元测试**（tests/unit/login-lock.test.ts 用内存里的
 *    FakeUser 打 helper），**不打 API、不落库** —— 也就是说「真的锁了」「DB 状态对」
 *    从来没被验证过。这里补上端到端版本。
 *
 * ## 用自己造的账号，不动共享 fixture
 *
 * 锁定会把账号卡住 15 分钟。如果拿 `tests/fixtures/fixtures.json` 里的
 * `admin@acme.test` 来测，万一中途失败没恢复，**后面所有用这个账号的测试全挂**。
 * 所以这里现造一个专用账号，用完删掉。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { allHttpFromTokensFile, type AllHttp } from '../helpers';
import { getSequelize } from '../../src/db';
import { Tenant, User } from '../../src/models';
import { hashPassword } from '../../src/lib/password';

const TEST_EMAIL = 'lock-test-admin@acme.test';
const TEST_PASSWORD = 'LockTest-123!';
const TENANT_CODE = 'acme';

describe('A4 · 登录失败锁定（端到端）', () => {
  let http: AllHttp;
  let tenantId = '';
  let userId = '';

  const login = async (password: string): Promise<{ status: number; body: unknown }> => {
    const res = await http.acmeAdmin.post(
      '/login',
      { tenant_code: TENANT_CODE, email: TEST_EMAIL, password },
      { validateStatus: () => true },
    );
    return { status: res.status, body: res.data };
  };

  const freshUser = async (): Promise<User> => {
    const u = await User.findByPk(userId);
    if (u === null) throw new Error('测试用户不见了');
    return u;
  };

  beforeAll(async () => {
    getSequelize();
    http = await allHttpFromTokensFile();
    const tenant = await Tenant.findOne({ where: { code: TENANT_CODE } });
    if (tenant === null) throw new Error('测试租户 acme 不存在 —— 先跑 yarn test:fixtures');
    tenantId = tenant.id;

    const created = await User.create({
      tenant_id: tenantId,
      email: TEST_EMAIL,
      password_hash: await hashPassword(TEST_PASSWORD),
      role: 'admin',
      must_change_password: false,
      failed_login_count: 0,
      locked_until: null,
    });
    userId = created.id;
  });

  afterAll(async () => {
    // 一定要清干净 —— 账号被锁 15 分钟会连累后面所有用它的测试
    await User.destroy({ where: { id: userId } });
  });

  it('连续 5 次错密码 → 账号被锁（DB 状态正确）', async () => {
    for (let i = 0; i < 5; i += 1) {
      const res = await login('WrongPassword-123!');
      expect(res.status).toBe(401);
    }
    const user = await freshUser();
    expect(user.failed_login_count).toBe(5);
    expect(user.locked_until).not.toBeNull();
    // 锁 15 分钟
    const minutes = ((user.locked_until as Date).getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThanOrEqual(15);
  });

  it('锁定期内用正确密码也登不进去（401）', async () => {
    const res = await login(TEST_PASSWORD);
    expect(res.status).toBe(401);
    // 锁定期间的响应跟「密码错」一模一样 —— 不告诉调用方「这个号被锁了」
    expect(res.body).toEqual({ code: 'AUTH_ERROR', message: '邮箱或密码错误' });
  });

  it('锁定期间错密码不再累加计数（不会把锁期无限延长）', async () => {
    const before = (await freshUser()).failed_login_count;
    await login('WrongPassword-123!');
    const after = (await freshUser()).failed_login_count;
    expect(after).toBe(before);
  });

  it('解锁后成功登录 → failed_login_count 清零 + locked_until 清空', async () => {
    // 把锁定时间改到过去 = 模拟锁定期结束
    const user = await freshUser();
    user.locked_until = new Date(Date.now() - 1000);
    user.failed_login_count = 5;
    await user.save();

    const res = await login(TEST_PASSWORD);
    expect(res.status).toBe(200);

    const after = await freshUser();
    expect(after.failed_login_count).toBe(0);
    expect(after.locked_until).toBeNull();
    expect(after.last_login_at).not.toBeNull();
  });

  it('一次成功登录会清掉之前累计的失败次数', async () => {
    const user = await freshUser();
    user.failed_login_count = 3;
    await user.save();

    const res = await login(TEST_PASSWORD);
    expect(res.status).toBe(200);
    expect((await freshUser()).failed_login_count).toBe(0);
  });
});
