#!/usr/bin/env tsx
/**
 * Step 2 端到端验收：跑通 docs/15 §Step 2 验收清单
 * 1. 手动 SQL 已插 system user（scripts/seed-system-admin.ts）
 * 2. 签 system JWT → POST /api/v1/system/tenants 建租户 + 初始 admin
 * 3. 查 tenants / users 表确认
 * 4. 签 admin JWT → GET / POST / PATCH / DELETE /api/v1/admin/users
 * 5. POST /api/v1/admin/change-password
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { config } from '../src/config';
import { signToken } from '../src/lib/jwt';

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
    // 留 raw text
  }
  return { status: res.status, data };
}

function logStep(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? '✅' : '❌'} ${label} — ${detail}`);
}

async function main(): Promise<void> {
  // 1) 取 system_user 真实 id
  const conn = await mysql.createConnection({
    host: config.MYSQL.HOST,
    port: config.MYSQL.PORT,
    user: config.MYSQL.USER,
    password: config.MYSQL.PASSWORD,
    database: config.MYSQL.DB,
  });
  const [sysRows] = await conn.query(
    "SELECT id FROM system_users WHERE email = 'platform-admin@local' LIMIT 1",
  );
  const sysUserId = (sysRows as Array<{ id: string }>)[0]?.id;
  if (sysUserId === undefined) {
    console.error('system_user 找不到；先跑 yarn tsx scripts/seed-system-admin.ts');
    process.exit(1);
  }
  console.log(`\n=== system_user.id = ${sysUserId} ===\n`);

  const systemToken = signToken({ sub: sysUserId, role: 'system' });
  console.log(`system JWT 已签发（len=${systemToken.length}）\n`);

  // 2) POST /api/v1/system/tenants —— 建租户「acme-corp」+ 初始 admin
  const tenantCode = `acme-${Date.now()}`; // 避免 UNIQUE 冲突
  const adminEmail = `admin@${tenantCode}.test`;
  const adminPassword = 'InitialPass-123';

  const create = await api(
    'POST',
    '/api/v1/system/tenants',
    {
      code: tenantCode,
      name: 'Acme Corp',
      admin_email: adminEmail,
      admin_password: adminPassword,
    },
    systemToken,
  );
  const createOk = create.status === 201;
  logStep(
    'POST /api/v1/system/tenants',
    createOk,
    `status=${create.status} body=${JSON.stringify(create.data)}`,
  );
  if (!createOk) {
    process.exit(1);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tenant = (create.data as any).tenant;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = (create.data as any).admin;
  console.log(`  ↳ tenant.id=${tenant.id}  admin.id=${admin.id}\n`);

  // 3) 二次提交同 code → 400
  const dup = await api(
    'POST',
    '/api/v1/system/tenants',
    {
      code: tenantCode,
      name: 'Acme 重复',
      admin_email: 'other@example.com',
      admin_password: 'OtherPass-123',
    },
    systemToken,
  );
  logStep('POST /api/v1/system/tenants（code 重复）', dup.status === 400, `status=${dup.status}`);

  // 4) 拿 admin 用户的 id（从 DB）
  const [userRows] = await conn.query('SELECT id FROM users WHERE email = ? LIMIT 1', [adminEmail]);
  const adminUserId = (userRows as Array<{ id: string }>)[0]?.id;
  if (adminUserId === undefined) {
    console.error('admin user 找不到');
    process.exit(1);
  }
  const adminToken = signToken({ sub: adminUserId, tenant_id: tenant.id, role: 'admin' });
  console.log(`\nadmin JWT 已签发（sub=${adminUserId}, tenant_id=${tenant.id}）\n`);

  // 5) GET /api/v1/admin/users
  const list = await api('GET', '/api/v1/admin/users', undefined, adminToken);
  const listOk = list.status === 200;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  logStep(
    'GET /api/v1/admin/users',
    listOk,
    `status=${list.status} count=${(list.data as any)?.users?.length ?? '?'}`,
  );

  // 6) POST /api/v1/admin/users —— 创建 3 个前台 / 坐席用户
  const newUserEmails: string[] = [];
  for (const role of ['customer', 'customer', 'customer'] as const) {
    const email = `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@acme.test`;
    newUserEmails.push(email);
    const created = await api(
      'POST',
      '/api/v1/admin/users',
      {
        email,
        password: 'NewUser-123',
        role,
      },
      adminToken,
    );
    logStep(
      `POST /api/v1/admin/users (${role})`,
      created.status === 201,
      `email=${email} status=${created.status}`,
    );
  }

  // 7) POST 同 email 重复 → 400
  const dup2 = await api(
    'POST',
    '/api/v1/admin/users',
    {
      email: newUserEmails[0],
      password: 'Other-123',
      role: 'customer',
    },
    adminToken,
  );
  logStep('POST /api/v1/admin/users（email 重复）', dup2.status === 400, `status=${dup2.status}`);

  // 8) PATCH /api/v1/admin/users/:id —— 改 email
  const [newUserRows] = await conn.query('SELECT id FROM users WHERE email = ? LIMIT 1', [
    newUserEmails[0],
  ]);
  const newUserId = (newUserRows as Array<{ id: string }>)[0]?.id;
  if (newUserId !== undefined) {
    const patched = await api(
      'PATCH',
      `/api/v1/admin/users/${newUserId}`,
      {
        email: `renamed-${Date.now()}@acme.test`,
      },
      adminToken,
    );
    logStep(
      'PATCH /api/v1/admin/users/:id (改 email)',
      patched.status === 200,
      `status=${patched.status}`,
    );
  }

  // 9) DELETE /api/v1/admin/users/:id
  if (newUserId !== undefined) {
    const del = await api('DELETE', `/api/v1/admin/users/${newUserId}`, undefined, adminToken);
    logStep('DELETE /api/v1/admin/users/:id', del.status === 204, `status=${del.status}`);
  }

  // 10) POST /api/v1/admin/change-password —— admin 自己改密码
  const chg = await api(
    'POST',
    '/api/v1/admin/change-password',
    {
      old_password: adminPassword,
      new_password: 'NewAdminPass-123',
    },
    adminToken,
  );
  logStep('POST /api/v1/admin/change-password', chg.status === 200, `status=${chg.status}`);

  // 11) 错密码 → 401
  const chgBad = await api(
    'POST',
    '/api/v1/admin/change-password',
    {
      old_password: 'wrong',
      new_password: 'NewAdminPass-123',
    },
    adminToken,
  );
  logStep(
    'POST /api/v1/admin/change-password（旧密码错）',
    chgBad.status === 401,
    `status=${chgBad.status}`,
  );

  // 12) 跨租户防御：伪造一个 tenant_id 不同但 role=admin 的 token
  const fakeToken = signToken({ sub: 'fake-user', tenant_id: 'other-tenant', role: 'admin' });
  const cross = await api('GET', '/api/v1/admin/users', undefined, fakeToken);
  logStep(
    'GET /api/v1/admin/users（伪造 tenant_id）',
    cross.status === 200 && JSON.stringify(cross.data).includes('[]'),
    `status=${cross.status} body=${JSON.stringify(cross.data).slice(0, 100)}`,
  );

  await conn.end();
  console.log('\n=== Step 2 验收完成 ===');
}

main().catch((e: unknown) => {
  console.error('脚本异常：', e);
  process.exit(1);
});
