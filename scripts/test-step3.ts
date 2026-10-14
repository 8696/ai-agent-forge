#!/usr/bin/env tsx
/**
 * Step 3 端到端验收（docs/15 §Step 3）：
 * 1. system user 登录（成功 / 错密码 / 错邮箱 / 5 次失败锁定）
 * 2. tenant user 登录（成功 / 错 tenant_code / 错密码 / 错 login_type）
 * 3. GET /api/v1/admin/me
 * 4. 锁定后即使密码对也 401
 * 5. 成功后 failed_login_count 清零
 */
import 'reflect-metadata';
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { config } from '../src/config';
import { hashPassword } from '../src/lib/password';
import { Tenant, User, SystemUser } from '../src/models';
import { getSequelize } from '../src/db';
import { nanoid } from 'nanoid';

const BASE = `http://localhost:${config.PORT}`;

async function api(
  method: string,
  path: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; data: unknown }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== undefined) headers['authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? null : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* keep raw */
  }
  return { status: res.status, data };
}

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail: string): void {
  if (ok) {
    pass += 1;
    console.log(`✅ ${label} — ${detail}`);
  } else {
    fail += 1;
    console.log(`❌ ${label} — ${detail}`);
  }
}

async function main(): Promise<void> {
  // 触发 Sequelize 初始化 + 模型注册
  getSequelize();

  // ===== 准备：清理 + 插入测试数据 =====
  const conn = await mysql.createConnection({
    host: config.MYSQL.HOST,
    port: config.MYSQL.PORT,
    user: config.MYSQL.USER,
    password: config.MYSQL.PASSWORD,
    database: config.MYSQL.DB,
  });
  // 清掉上轮测试的 system user / tenant / user
  await conn.execute("DELETE FROM system_users WHERE email LIKE 'sys-test-%'");
  await conn.execute("DELETE FROM users WHERE email LIKE 'tenant-test-%'");
  await conn.execute("DELETE FROM tenants WHERE code LIKE 'step3-%'");

  // 准备 system user
  const sysId = nanoid(21);
  const sysEmail = `sys-test-${Date.now()}@local.test`;
  const sysPw = 'SysPass-123';
  await SystemUser.create({
    id: sysId,
    email: sysEmail,
    password_hash: await hashPassword(sysPw),
    name: 'Step3 sys test',
    role: 'system',
  });
  console.log(`\n=== seed: system user ${sysEmail} ===\n`);

  // 准备租户 + admin user + customer user
  const tenantCode = `step3-${Date.now()}`;
  const tenant = await Tenant.create({ code: tenantCode, name: 'Step3 Tenant' });
  const adminEmail = `tenant-test-admin-${Date.now()}@step3.test`;
  const customerEmail = `tenant-test-customer-${Date.now()}@step3.test`;
  const userPw = 'UserPass-123';
  const adminUser = await User.create({
    tenant_id: tenant.id,
    email: adminEmail,
    password_hash: await hashPassword(userPw),
    role: 'admin',
  });
  await User.create({
    tenant_id: tenant.id,
    email: customerEmail,
    password_hash: await hashPassword(userPw),
    role: 'customer',
  });
  console.log(`=== seed: tenant ${tenantCode} + admin + customer ===\n`);

  // ===== 1) system user 登录 =====
  const sysOk = await api('POST', '/api/v1/system/login', { email: sysEmail, password: sysPw });
  check('system 登录（正确）', sysOk.status === 200, `status=${sysOk.status}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sysToken = (sysOk.data as any).token as string | undefined;

  const sysBadPw = await api('POST', '/api/v1/system/login', {
    email: sysEmail,
    password: 'wrong',
  });
  check('system 登录（错密码）', sysBadPw.status === 401, `status=${sysBadPw.status}`);

  const sysBadEmail = await api('POST', '/api/v1/system/login', {
    email: 'noone@nowhere.test',
    password: 'x',
  });
  check('system 登录（错邮箱）', sysBadEmail.status === 401, `status=${sysBadEmail.status}`);
  // 错误响应应该是同一条 message（防账号枚举）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const msg1 = (sysBadPw.data as any).message;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const msg2 = (sysBadEmail.data as any).message;
  check('system 错误响应统一（防枚举）', msg1 === msg2, `错密码="${msg1}" / 错邮箱="${msg2}"`);

  // ===== 2) tenant user 登录（每个子系统自己的端点）=====
  const adminOk = await api('POST', '/api/v1/admin/login', {
    email: adminEmail,
    password: userPw,
    tenant_code: tenantCode,
  });
  check('tenant admin 登录（正确）', adminOk.status === 200, `status=${adminOk.status}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminToken = (adminOk.data as any).token as string | undefined;

  const customerOk = await api('POST', '/api/v1/customer/login', {
    email: customerEmail,
    password: userPw,
    tenant_code: tenantCode,
  });
  check('tenant customer 登录（正确）', customerOk.status === 200, `status=${customerOk.status}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const customerToken = (customerOk.data as any).token as string | undefined;

  const wrongTenant = await api('POST', '/api/v1/admin/login', {
    email: adminEmail,
    password: userPw,
    tenant_code: 'no-such-tenant',
  });
  check('admin 登录（错租户号）', wrongTenant.status === 401, `status=${wrongTenant.status}`);

  // 用 admin 账号去 customer 端点登录 → 应该 401（customer 端点锁死 role=customer）
  const adminToCustomer = await api('POST', '/api/v1/customer/login', {
    email: adminEmail,
    password: userPw,
    tenant_code: tenantCode,
  });
  check(
    'admin 账号登 customer 端点 → 401',
    adminToCustomer.status === 401,
    `status=${adminToCustomer.status}`,
  );

  // 用 customer 账号去 admin 端点登录 → 应该 401（admin 端点锁死 role=admin）
  const customerToAdmin = await api('POST', '/api/v1/admin/login', {
    email: customerEmail,
    password: userPw,
    tenant_code: tenantCode,
  });
  check(
    'customer 账号登 admin 端点 → 401',
    customerToAdmin.status === 401,
    `status=${customerToAdmin.status}`,
  );

  const wrongPw = await api('POST', '/api/v1/admin/login', {
    email: adminEmail,
    password: 'wrong',
    tenant_code: tenantCode,
  });
  check('admin 登录（错密码）', wrongPw.status === 401, `status=${wrongPw.status}`);

  // ===== 3) GET /me（每个子系统自己的 /me 端点）=====
  const meAdmin = await api('GET', '/api/v1/admin/me', undefined, adminToken);
  const meAdminBody = meAdmin.data as { role?: string } | undefined;
  check(
    'GET /api/v1/admin/me（admin token）',
    meAdmin.status === 200 && meAdminBody?.role === 'admin',
    `status=${meAdmin.status} role=${meAdminBody?.role ?? '?'}`,
  );

  const meCustomer = await api('GET', '/api/v1/customer/me', undefined, customerToken);
  const meCustomerBody = meCustomer.data as { role?: string } | undefined;
  check(
    'GET /api/v1/customer/me（customer token）',
    meCustomer.status === 200 && meCustomerBody?.role === 'customer',
    `status=${meCustomer.status} role=${meCustomerBody?.role ?? '?'}`,
  );

  // system token 调 /admin/me 应该 401（system 不是 tenant user）
  const meSys = await api('GET', '/api/v1/admin/me', undefined, sysToken);
  check(
    'GET /api/v1/admin/me（system token，拒绝）',
    meSys.status === 401,
    `status=${meSys.status}`,
  );

  // admin token 调 /customer/me 应该 401（admin 不是 customer）
  const meAdminToCustomer = await api('GET', '/api/v1/customer/me', undefined, adminToken);
  check(
    'GET /api/v1/customer/me（admin token，拒绝）',
    meAdminToCustomer.status === 401,
    `status=${meAdminToCustomer.status}`,
  );

  // ===== 4) 5 次失败 → 锁定 =====
  // 拿一个新 user 专门测锁定
  const lockEmail = `tenant-test-lock-${Date.now()}@step3.test`;
  await User.create({
    tenant_id: tenant.id,
    email: lockEmail,
    password_hash: await hashPassword(userPw),
    role: 'customer',
  });
  for (let i = 0; i < 5; i += 1) {
    await api('POST', '/api/v1/customer/login', {
      email: lockEmail,
      password: 'wrong',
      tenant_code: tenantCode,
    });
  }
  // 第 6 次：正确密码 → 应该 401（账号被锁）
  const lockedEvenCorrect = await api('POST', '/api/v1/customer/login', {
    email: lockEmail,
    password: userPw,
    tenant_code: tenantCode,
  });
  check(
    '锁定后正确密码也 401',
    lockedEvenCorrect.status === 401,
    `status=${lockedEvenCorrect.status}`,
  );

  // 查 DB 确认锁定状态（关键看 failed_login_count >= 5 且 locked_until 已写入）
  const [lockRows] = await conn.query(
    'SELECT failed_login_count, locked_until FROM users WHERE email = ?',
    [lockEmail],
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lockState = (lockRows as any[])[0];
  check(
    '锁定后 DB 状态正确（failed_login_count>=5 且 locked_until 已写）',

    lockState !== undefined && lockState.failed_login_count >= 5 && lockState.locked_until !== null,
    `failed_login_count=${lockState?.failed_login_count} locked_until=${lockState?.locked_until}`,
  );

  // ===== 5) 成功登录后 failed_login_count 清零 =====
  const before = (await conn.query('SELECT failed_login_count FROM users WHERE id = ?', [
    adminUser.id,
  ])) as [Array<{ failed_login_count: number }>, unknown];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const beforeCount = (before[0] as any[])[0]?.failed_login_count;
  // 让 admin 错 1 次
  await api('POST', '/api/v1/admin/login', {
    email: adminEmail,
    password: 'wrong',
    tenant_code: tenantCode,
    login_type: 'admin',
  });
  // 然后成功
  await api('POST', '/api/v1/admin/login', {
    email: adminEmail,
    password: userPw,
    tenant_code: tenantCode,
    login_type: 'admin',
  });
  const after = (await conn.query('SELECT failed_login_count FROM users WHERE id = ?', [
    adminUser.id,
  ])) as [Array<{ failed_login_count: number }>, unknown];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const afterCount = (after[0] as any[])[0]?.failed_login_count;
  check(
    '成功登录后 failed_login_count 清零',

    afterCount === 0,
    `before=${beforeCount} after=${afterCount}`,
  );

  // ===== 6) 旧流程验证：admin 登录 → 改密 → 创建前台用户（Step 2 完整链路） =====
  // 改密
  const chg = await api(
    'POST',
    '/api/v1/admin/change-password',
    { old_password: userPw, new_password: 'NewAdminPass-123' },
    adminToken,
  );
  check('admin 改密码（已登录）', chg.status === 200, `status=${chg.status}`);
  // 用新密码调 /me，确认 token 还有效
  const meAfter = await api('GET', '/api/v1/admin/me', undefined, adminToken);
  check('改密后 /me 仍 OK', meAfter.status === 200, `status=${meAfter.status}`);

  // 清理
  await conn.execute('DELETE FROM system_users WHERE email = ?', [sysEmail]);
  await conn.execute("DELETE FROM users WHERE email LIKE 'tenant-test-%'");
  await conn.execute('DELETE FROM tenants WHERE code = ?', [tenantCode]);
  await conn.end();

  console.log(`\n=== Step 3 验收：${pass} 通过 / ${fail} 失败 ===`);
  if (fail > 0) process.exit(1);
}

main().catch((e: unknown) => {
  console.error('脚本异常：', e);
  process.exit(1);
});
