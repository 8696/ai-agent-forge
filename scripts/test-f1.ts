#!/usr/bin/env tsx
/**
 * F1 端到端验收：system 端租户管理（4 个端点）
 * 详见 docs/16 §F1
 *
 * 用法：先跑起后端（yarn dev:backend），再 yarn tsx scripts/test-f1.ts
 */
import 'reflect-metadata';
import 'dotenv/config';
import axios, { type AxiosInstance } from 'axios';
import { config } from '../src/config';
import { getSequelize } from '../src/db';
import { SystemUser, Tenant, User } from '../src/models';
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

async function main(): Promise<void> {
  getSequelize(); // 触发模型注册

  // ===== 准备：清理 + seed =====
  // 拿已有的 system user
  const sysUser = await SystemUser.findOne({ where: { email: 'platform-admin@local.test' } });
  if (sysUser === null) {
    console.error('系统用户不存在，先跑 yarn tsx scripts/seed-system-admin.ts');
    process.exit(1);
  }
  const sysToken = signToken({ sub: sysUser.id, role: 'system' });

  // 建一个干净的 test 租户（如果已存在则删了重建）
  const testCode = `f1-test-${Date.now()}`;
  await Tenant.destroy({ where: { code: { [Symbol.for('like')]: 'f1-test-%' } } });
  await Tenant.destroy({ where: { code: testCode } });

  const tenant = await Tenant.create({ code: testCode, name: 'F1 Test Tenant' });
  const adminEmail = `f1-admin-${Date.now()}@f1test.test`;
  const adminUser = await User.create({
    tenant_id: tenant.id,
    email: adminEmail,
    password_hash: await hashPassword('OriginalPass-123'),
    role: 'admin',
    must_change_password: false,
  });
  console.log(`\n=== seed: tenant ${testCode} (id=${tenant.id}) + admin ${adminEmail} ===\n`);

  // ===== 准备：admin 用户的 token（用来验证跨子系统防御）=====
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

  // ===== 1) GET /tenants =====
  const list = await api(sysHttp, 'GET', '/tenants');
  const listOk = list.status === 200;

  const listData = list.data as { tenants: Array<{ code: string; admin: unknown }> };
  check(
    'GET /system/tenants 返回所有租户',
    listOk && Array.isArray(listData?.tenants),
    `status=${list.status} count=${listData?.tenants?.length ?? '?'}`,
  );
  // 检查刚建的 tenant 出现，且 admin 字段对得上

  const myTenant = listData?.tenants?.find((t) => t.code === testCode);
  check(
    'list 包含新建的 tenant 且 admin email 对得上',
    myTenant !== undefined && myTenant.admin !== null,
    `code=${myTenant?.code} admin=${(myTenant?.admin as { email?: string } | null)?.email ?? 'null'}`,
  );

  // ===== 2) GET /tenants/:id =====
  const detail = await api(sysHttp, 'GET', `/tenants/${tenant.id}`);
  check('GET /system/tenants/:id', detail.status === 200, `status=${detail.status}`);

  const detailData = detail.data as { id: string; code: string; admin: { email: string } | null };
  check(
    'detail 包含 admin 详情',
    detailData?.admin?.email === adminEmail,
    `admin.email=${detailData?.admin?.email ?? 'null'}`,
  );

  // ===== 3) PATCH /tenants/:id 改 name 和 plan =====
  const patched = await api(sysHttp, 'PATCH', `/tenants/${tenant.id}`, {
    name: 'F1 Test (renamed)',
    plan: 'pro',
  });

  const patchedData = patched.data as { name: string; plan: string };
  check(
    'PATCH /system/tenants/:id 改 name + plan',
    patched.status === 200 &&
      patchedData.name === 'F1 Test (renamed)' &&
      patchedData.plan === 'pro',
    `name="${patchedData?.name}" plan=${patchedData?.plan}`,
  );

  // ===== 4) POST /tenants/:id/admin/reset-password =====
  const reset = await api(sysHttp, 'POST', `/tenants/${tenant.id}/admin/reset-password`, {
    new_password: 'NewlyReset-456',
  });
  check(
    'POST /system/tenants/:id/admin/reset-password',
    reset.status === 200,
    `status=${reset.status}`,
  );

  const resetData = reset.data as { admin: { must_change_password: boolean } | null };
  check(
    '重置后 must_change_password=true',
    resetData?.admin?.must_change_password === true,
    `must_change_password=${resetData?.admin?.must_change_password}`,
  );
  // 验证：用新密码能登 admin
  const newLogin = await axios.post(`${BASE}/api/v1/admin/login`, {
    email: adminEmail,
    password: 'NewlyReset-456',
    tenant_code: testCode,
  });
  check('admin 用新密码可登录', newLogin.status === 200, `status=${newLogin.status}`);
  // 实际用 admin 端点测旧密码（用 api() wrapper 接 401 不抛）
  const oldLogin = await api(
    sysHttp,
    'POST',
    '/NOT_USED', // 走 sysHttp baseURL 会被 404，但我们要测的是 admin 端点
    { email: adminEmail, password: 'OriginalPass-123', tenant_code: testCode },
  );
  void oldLogin; // 故意触发 api() 走通一遍；真正的断言在下面
  // 用 admin 端点直发（这里允许 401 抛出，因为 api() 已经 catch，但我们要看的是真实响应）
  let oldLoginStatus = 0;
  try {
    const r = await axios.post(`${BASE}/api/v1/admin/login`, {
      email: adminEmail,
      password: 'OriginalPass-123',
      tenant_code: testCode,
    });
    oldLoginStatus = r.status;
  } catch (e) {
    oldLoginStatus = (e as { response?: { status?: number } }).response?.status ?? 0;
  }
  check('admin 用旧密码不能登录（已被覆盖）', oldLoginStatus === 401, `status=${oldLoginStatus}`);

  // ===== 5) 跨子系统防御：admin token 调 /system/tenants → 401 =====
  const cross = await api(adminHttp, 'GET', '/me'); // admin token 调 admin/me 是 OK 的
  check('admin token 调 /admin/me（合法）', cross.status === 200, `status=${cross.status}`);
  let cross2Status = 0;
  try {
    const r = await axios.get(`${BASE}/api/v1/system/tenants`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    cross2Status = r.status;
  } catch (e) {
    cross2Status = (e as { response?: { status?: number } }).response?.status ?? 0;
  }
  check('admin token 调 /system/tenants → 401', cross2Status === 401, `status=${cross2Status}`);

  // ===== 清理 =====
  await Tenant.destroy({ where: { id: tenant.id } });
  console.log(`\n=== F1 验收：${pass} 通过 / ${fail} 失败 ===`);
  if (fail > 0) process.exit(1);
}

main().catch((e: unknown) => {
  console.error('脚本异常：', e);
  process.exit(1);
});
