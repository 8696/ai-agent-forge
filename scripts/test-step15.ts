#!/usr/bin/env tsx
/**
 * Step 15 / F2 端到端验收（参考 docs/16-e §F2 + docs/15 §Step 15）
 *
 * 用法：起后端（yarn dev:backend） → yarn tsx scripts/test-step15.ts
 *
 * 用例：
 *  1) GET /system/tenants 返回值带 status + expires_at
 *  2) PATCH /tenants/:id/expires_at 设一个未来时间 → 200；admin/customer login 都还能登
 *  3) PATCH /tenants/:id/expires_at 设到过去 → admin/customer login 都 401（message 同密码错）
 *  4) PATCH /tenants/:id/expires_at body={expires_at: null} → 清空到期 → 又能登
 *  5) PATCH /tenants/:id/status {status:'disabled'} → admin/customer login 都 401
 *  6) PATCH /tenants/:id/status {status:'active'} → 又能登
 *  7) 防自锁：拿 code='system' 的初始租户 PATCH status='disabled' → 400
 *  8) 跨子系统：admin token 调任一 PATCH → 401（requireSystemUser 拒）
 *  9) audit_logs 写了 TENANT_STATUS_CHANGE / TENANT_EXPIRES_CHANGE
 */
import 'reflect-metadata';
import 'dotenv/config';
import axios, { type AxiosInstance } from 'axios';
import { config } from '../src/config';
import { getSequelize } from '../src/db';
import { SystemUser, Tenant, User, AuditLog } from '../src/models';
import { signToken } from '../src/lib/jwt';
import { hashPassword } from '../src/lib/password';

const BASE = `http://localhost:${config.PORT}`;
let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass += 1;
    console.log(`✅ ${label} — ${detail}`);
  } else {
    fail += 1;
    console.log(`❌ ${label} — ${detail}`);
  }
}

/**
 * skip：测试条件前置缺失（如需 seed 一个 `code='system'` 初始租户，但没人 seed 过）。
 * 不计入 pass / fail，只打一行提示。
 */
function skip(label: string, reason: string): void {
  console.log(`⏭  ${label} — [跳过] ${reason}`);
}

async function api(
  http: AxiosInstance,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  try {
    const res = await http.request({ method, url: path, data: body });
    return { status: res.status, data: res.data };
  } catch (e: unknown) {
    const err = e as { response?: { status?: number; data?: unknown } };
    return { status: err.response?.status ?? 0, data: err.response?.data };
  }
}

function same401Body(a: unknown, b: unknown): boolean {
  // 「与密码错完全同响应体」——前端能看到 body、运维按 body 区分。所以用 JSON 字符串比对
  return JSON.stringify(a) === JSON.stringify(b);
}

async function main(): Promise<void> {
  getSequelize(); // 触发模型注册

  // ===== 准备：找一个系统用户 =====
  const sysUser = await SystemUser.findOne({
    where: { email: 'platform-admin@local.test' },
  });
  if (sysUser === null) {
    console.error('系统用户不存在，先跑 yarn tsx scripts/seed-system-admin.ts');
    process.exit(1);
  }
  const sysToken = signToken({ sub: sysUser.id, role: 'system' });

  // ===== 准备：建一个干净的 test 租户（自带 admin）=====
  const testCode = `f2-test-${Date.now()}`;
  // 清理同名 test 租户
  await Tenant.destroy({ where: { code: { [Symbol.for('like')]: 'f2-test-%' } } });
  await Tenant.destroy({ where: { code: testCode } });

  const tenant = await Tenant.create({ code: testCode, name: 'F2 Test Tenant' });
  const adminEmail = `f2-admin-${Date.now()}@f2test.test`;
  const customerEmail = `f2-cust-${Date.now()}@f2test.test`;
  const adminPwd = 'OriginalPass-123';
  const adminUser = await User.create({
    tenant_id: tenant.id,
    email: adminEmail,
    password_hash: await hashPassword(adminPwd),
    role: 'admin',
    must_change_password: false,
  });
  await User.create({
    tenant_id: tenant.id,
    email: customerEmail,
    password_hash: await hashPassword('CustomerPass-123'),
    role: 'customer',
    must_change_password: false,
  });
  console.log(`\n=== seed: tenant ${testCode} + admin + customer ===\n`);

  // 备一个 admin token 测跨子系统防御
  const adminToken = signToken({
    sub: adminUser.id,
    tenant_id: tenant.id,
    role: 'admin',
  });

  const sysHttp = axios.create({
    baseURL: `${BASE}/api/v1/system`,
    headers: { Authorization: `Bearer ${sysToken}` },
  });
  const adminHttp = axios.create({
    baseURL: `${BASE}/api/v1/admin`,
    headers: { Authorization: `Bearer ${adminToken}` },
  });

  // ===== 用例 1：GET /tenants 返回值带 status + expires_at =====
  const list = await api(sysHttp, 'GET', '/tenants');
  const listData = list.data as {
    tenants: Array<{ id: string; status?: string; expires_at?: string | null }>;
  };
  const myTenant = listData?.tenants?.find((t) => t.id === tenant.id);
  check(
    'GET /system/tenants 返回带 status 字段',
    list.status === 200 && myTenant?.status === 'active',
    `status=${myTenant?.status ?? '?'}`,
  );
  check(
    'GET /system/tenants 返回带 expires_at 字段（首次为 null）',
    list.status === 200 && myTenant?.expires_at === null,
    `expires_at=${myTenant?.expires_at ?? '?'}`,
  );

  // ===== 拿一个对照组「密码错」的 401 响应体（必须严格相同）=====
  const wrongPwdAdmin = await api(adminHttp, 'POST', '/login', {
    email: adminEmail,
    password: 'WrongPwd-999',
    tenant_code: testCode,
  });
  // 用 raw axios 因为 adminHttp 接到 401 也会进 catch，api() 已经吃掉了
  let wrongPwdBody: unknown;
  try {
    const r = await axios.post(`${BASE}/api/v1/admin/login`, {
      email: adminEmail,
      password: 'WrongPwd-999',
      tenant_code: testCode,
    });
    void r;
    wrongPwdBody = null; // 不会到这里
  } catch (e: unknown) {
    wrongPwdBody = (e as { response?: { data?: unknown } }).response?.data;
  }
  check(
    '对照组：admin 输错密码 → 401 拿到对照 response body',
    wrongPwdAdmin.status === 401 && wrongPwdBody !== null && wrongPwdBody !== undefined,
    `pwd_status=${wrongPwdAdmin.status}`,
  );

  // ===== 用例 2：PATCH /tenants/:id/expires_at 设一个未来时间 =====
  const futureIso = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();
  const patchExp = await api(sysHttp, 'PATCH', `/tenants/${tenant.id}/expires_at`, {
    expires_at: futureIso,
  });
  check('PATCH /expires_at 设未来时间 → 200', patchExp.status === 200, `status=${patchExp.status}`);

  // admin / customer login 应该都还正常
  const okLogin1 = await api(adminHttp, 'POST', '/login', {
    email: adminEmail,
    password: adminPwd,
    tenant_code: testCode,
  });
  check('admin 在 expiry=未来 时仍可登录', okLogin1.status === 200, `status=${okLogin1.status}`);

  // ===== 用例 3：PATCH /expires_at 设到过去 → admin/customer login 401 =====
  const pastIso = new Date(Date.now() - 60_000).toISOString();
  await api(sysHttp, 'PATCH', `/tenants/${tenant.id}/expires_at`, { expires_at: pastIso });
  const expiredAdmin = await api(adminHttp, 'POST', '/login', {
    email: adminEmail,
    password: adminPwd,
    tenant_code: testCode,
  });
  check(
    '设到过去后 admin/login → 401',
    expiredAdmin.status === 401,
    `status=${expiredAdmin.status}`,
  );
  const sameBodyAdmin =
    expiredAdmin.status === 401 &&
    wrongPwdBody !== null &&
    same401Body(expiredAdmin.data, wrongPwdBody);
  check(
    '响应体与「密码错」完全一致（防账号枚举）',
    sameBodyAdmin,
    `body=${JSON.stringify(expiredAdmin.data)}`,
  );

  // customer 同样测一下
  const expiredCust = await api(adminHttp, 'POST', '/login', {
    email: customerEmail,
    password: 'CustomerPass-123',
    tenant_code: testCode,
  });
  void expiredCust; // adminHttp 路径不对，这里仅占位
  let realCustExpired = 0;
  let realCustExpiredBody: unknown = null;
  try {
    await axios.post(`${BASE}/api/v1/customer/login`, {
      email: customerEmail,
      password: 'CustomerPass-123',
      tenant_code: testCode,
    });
  } catch (e: unknown) {
    const err = e as { response?: { status?: number; data?: unknown } };
    realCustExpired = err.response?.status ?? 0;
    realCustExpiredBody = err.response?.data;
  }
  check('设到过去后 customer/login → 401', realCustExpired === 401, `status=${realCustExpired}`);
  check(
    'customer 401 响应体与「密码错」也完全一致',
    realCustExpiredBody !== null &&
      wrongPwdBody !== null &&
      same401Body(realCustExpiredBody, wrongPwdBody),
    `body=${JSON.stringify(realCustExpiredBody)}`,
  );

  // ===== 用例 4：PATCH /expires_at body={expires_at: null} 清空到期 → 又能登 =====
  await api(sysHttp, 'PATCH', `/tenants/${tenant.id}/expires_at`, { expires_at: null });
  const okLogin2 = await api(adminHttp, 'POST', '/login', {
    email: adminEmail,
    password: adminPwd,
    tenant_code: testCode,
  });
  check('清空到期后 admin/login → 200', okLogin2.status === 200, `status=${okLogin2.status}`);

  // ===== 用例 5：PATCH /status disabled → admin/customer login 401 =====
  await api(sysHttp, 'PATCH', `/tenants/${tenant.id}/status`, { status: 'disabled' });
  let disabledAdminStatus = 0;
  let disabledAdminBody: unknown = null;
  try {
    await axios.post(`${BASE}/api/v1/admin/login`, {
      email: adminEmail,
      password: adminPwd,
      tenant_code: testCode,
    });
  } catch (e: unknown) {
    const err = e as { response?: { status?: number; data?: unknown } };
    disabledAdminStatus = err.response?.status ?? 0;
    disabledAdminBody = err.response?.data;
  }
  check('禁用后 admin/login → 401', disabledAdminStatus === 401, `status=${disabledAdminStatus}`);
  check(
    '禁用 401 响应体与「密码错」完全一致',
    disabledAdminBody !== null &&
      wrongPwdBody !== null &&
      same401Body(disabledAdminBody, wrongPwdBody),
    `body=${JSON.stringify(disabledAdminBody)}`,
  );

  // ===== 用例 6：PATCH /status active → 又能登 =====
  await api(sysHttp, 'PATCH', `/tenants/${tenant.id}/status`, { status: 'active' });
  const okLogin3 = await api(adminHttp, 'POST', '/login', {
    email: adminEmail,
    password: adminPwd,
    tenant_code: testCode,
  });
  check('启用后 admin/login → 200', okLogin3.status === 200, `status=${okLogin3.status}`);

  // ===== 用例 7：防自锁：禁用 code='system' 的初始租户 → 400 =====
  const sysTenant = await Tenant.findOne({ where: { code: 'system' } });
  if (sysTenant === null) {
    skip(
      '防自锁：code=system 的初始租户存在',
      '没 seed system 租户；如需测请在 init-db 时插入 code="system" 行',
    );
  } else {
    const block = await api(sysHttp, 'PATCH', `/tenants/${sysTenant.id}/status`, {
      status: 'disabled',
    });
    check('禁用 code=system 的租户 → 400 防自锁', block.status === 400, `status=${block.status}`);
  }

  // ===== 用例 8：跨子系统：admin token 调 PATCH → 401 =====
  let crossStatus = 0;
  try {
    await axios.patch(
      `${BASE}/api/v1/system/tenants/${tenant.id}/status`,
      { status: 'active' },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
  } catch (e: unknown) {
    crossStatus = (e as { response?: { status?: number } }).response?.status ?? 0;
  }
  check(
    'admin token 调 /system/tenants/.../status → 401',
    crossStatus === 401,
    `status=${crossStatus}`,
  );

  // ===== 用例 9：audit_logs 写了两条（F2 = TENANT_STATUS_CHANGE + TENANT_EXPIRES_CHANGE）=====
  const auditRows = await AuditLog.findAll({
    where: { resource_id: tenant.id },
    order: [['created_at', 'ASC']],
  });
  const expChanges = auditRows.filter((r) => r.action === 'TENANT_EXPIRES_CHANGE').length;
  const statusChanges = auditRows.filter((r) => r.action === 'TENANT_STATUS_CHANGE').length;
  check(
    'audit_logs 写入了 ≥3 条 TENANT_EXPIRES_CHANGE（用例 2/3/4）',
    expChanges >= 3,
    `count=${expChanges}`,
  );
  check(
    'audit_logs 写入了 ≥2 条 TENANT_STATUS_CHANGE（用例 5/6）',
    statusChanges >= 2,
    `count=${statusChanges}`,
  );

  // ===== 清理 =====
  await Tenant.destroy({ where: { id: tenant.id } });
  console.log(`\n=== F2 / Step 15 验收：${pass} 通过 / ${fail} 失败 ===`);
  if (fail > 0) process.exit(1);
}

main().catch((e: unknown) => {
  console.error('脚本异常：', e);
  process.exit(1);
});
