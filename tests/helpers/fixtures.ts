/**
 * 测试 fixture 落库 —— docs/16-d §D6 测试基建契约
 *
 * 提供：
 *   - seedFixtures()      一键幂等 seed：1 system user + 2 tenants + 各租户 1 admin + 1 customer + 1 API key
 *   - destroyFixtures()   反向：清掉某租户的所有数据（默认全清）
 *
 * 数据定义来自 scripts/fixtures.json（前端 web/e2e/login-all.mjs 也读它，单源真相）
 */
import 'reflect-metadata';
import bcrypt from 'bcrypt';
import { nanoid } from 'nanoid';
import { getSequelize } from '../../src/db';
import { ApiKey, Tenant, User, SystemUser } from '../../src/models';
import { hashPassword } from '../../src/lib/password';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import fixturesJson from '../fixtures/fixtures.json' with { type: 'json' };

export interface SeededFixture {
  systemUser: { id: string; email: string; password: string };
  tenants: Array<{
    code: string;
    tenantId: string;
    admin: { id: string; email: string; password: string };
    customer: { id: string; email: string; password: string };
    apiKey: { raw: string; prefix: string; name: string };
  }>;
}

/**
 * 把一条 record upsert（按 email/tenant_id/code 唯一键找 → 不存在再 create）
 * 返回最终对象。幂等：跑 N 次结果一致。
 */
async function upsertTenant(code: string, name: string): Promise<Tenant> {
  const [t] = await Tenant.findOrCreate({
    where: { code },
    defaults: { code, name, plan: 'pro', status: 'active' },
  });
  return t;
}

async function upsertUser(
  tenantId: string,
  email: string,
  password: string,
  role: 'admin' | 'customer',
): Promise<User> {
  const [u] = await User.findOrCreate({
    where: { tenant_id: tenantId, email, role },
    defaults: {
      tenant_id: tenantId,
      email,
      password_hash: await hashPassword(password),
      role,
      must_change_password: false,
    },
  });
  return u;
}

async function upsertSystemUser(
  email: string,
  password: string,
  name: string,
): Promise<SystemUser> {
  const [u] = await SystemUser.findOrCreate({
    where: { email },
    defaults: {
      email,
      password_hash: await hashPassword(password),
      name,
      role: 'system',
    },
  });
  return u;
}

/**
 * 重建租户 API Key：name 固定 + 同一 prefix 但 hash 不可复用 → 先清同名 key 再插新的
 * raw 每次 seed 都重生成（hash 不能反推），返回新的 raw 让调用方记下来。
 */
async function rotateApiKey(
  tenantId: string,
  createdBy: string,
  name: string,
): Promise<{ raw: string; prefix: string }> {
  await ApiKey.destroy({ where: { tenant_id: tenantId, name } });
  const raw = `ak_${nanoid(32)}`;
  const prefix = raw.slice(0, 8);
  await ApiKey.create({
    tenant_id: tenantId,
    name,
    key_prefix: prefix,
    key_hash: await bcrypt.hash(raw, 12),
    created_by: createdBy,
  });
  return { raw, prefix };
}

/**
 * 一键幂等 seed 整套测试 fixture
 */
export async function seedFixtures(): Promise<SeededFixture> {
  getSequelize(); // 触发 init

  const fx = fixturesJson;

  // 1. system user
  const sys = await upsertSystemUser(fx.system.email, fx.system.password, fx.system.name);

  // 2. 每个租户：tenant + admin + customer + api key
  const tenants: SeededFixture['tenants'] = [];
  for (const t of fx.tenants) {
    const tenant = await upsertTenant(t.code, t.name);
    const admin = await upsertUser(tenant.id, t.admin.email, t.admin.password, 'admin');
    const customer = await upsertUser(
      tenant.id,
      t.customer.email,
      t.customer.password,
      'customer',
    );
    const apiKey = await rotateApiKey(tenant.id, admin.id, t.apiKeyName);
    tenants.push({
      code: t.code,
      tenantId: tenant.id,
      admin: { id: admin.id, email: t.admin.email, password: t.admin.password },
      customer: { id: customer.id, email: t.customer.email, password: t.customer.password },
      apiKey: { raw: apiKey.raw, prefix: apiKey.prefix, name: t.apiKeyName },
    });
  }

  return {
    systemUser: { id: sys.id, email: fx.system.email, password: fx.system.password },
    tenants,
  };
}

/**
 * 反向：清掉某租户的所有测试数据；默认清掉所有 fixture.json 里的租户
 */
export async function destroyFixtures(opts: { tenantCode?: string } = {}): Promise<void> {
  getSequelize();
  const fx = fixturesJson;
  const codes = opts.tenantCode !== undefined ? [opts.tenantCode] : fx.tenants.map((t) => t.code);
  for (const code of codes) {
    const t = await Tenant.findOne({ where: { code } });
    if (t === null) continue;
    await ApiKey.destroy({ where: { tenant_id: t.id } });
    await User.destroy({ where: { tenant_id: t.id } });
    await Tenant.destroy({ where: { id: t.id } });
  }
}

/**
 * 暴露原始 fixtures 数据（scripts/seed.ts / login-all.mjs 都用它打印凭据）
 */
export function getFixtures(): typeof fixturesJson {
  return fixturesJson;
}
