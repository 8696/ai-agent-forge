import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Op } from 'sequelize';
import { getSequelize } from '../../src/db';
import { Document, Tenant } from '../../src/models';
import { runWithTenant } from '../../src/lib/tenant-context';
import { TenantIsolationError } from '../../src/lib/errors';

/**
 * 租户作用域的**运行时强制** —— docs/12-a-需求-多租户与登录.md §A1
 *
 * 验证的是「忘了加 `tenant_id` 过滤也不会跨租户」这条不变量：
 * 运行时钩子（`src/lib/tenant-scope.ts`）会在查询发出前自动补上过滤。
 *
 * ⚠️ 静态约束测试（tests/unit/tenant-isolation-guard.test.ts）管的是
 *    「源码里有没有写对」，这里管的是「运行时到底拦不拦得住」。
 */

const DOC_PREFIX = 'tenant-scope-test-';

async function tenantIdOf(code: string): Promise<string> {
  const t = await Tenant.findOne({ where: { code } });
  if (t === null) {
    throw new Error(`测试租户 ${code} 不存在 —— 先跑 yarn test:fixtures`);
  }
  return t.id;
}

describe('租户作用域 · 运行时强制（A1）', () => {
  let acmeId = '';
  let globexId = '';

  beforeAll(async () => {
    getSequelize(); // 把模型挂到 Sequelize 实例上（不建表，只注册）
    acmeId = await tenantIdOf('acme');
    globexId = await tenantIdOf('globex');
    // 每个租户造一条文档（只造元数据，不入向量库）
    await Document.destroy({ where: { title: { [Op.like]: `${DOC_PREFIX}%` } } });
    for (const tenantId of [acmeId, globexId]) {
      await Document.create({
        tenant_id: tenantId,
        title: `${DOC_PREFIX}${tenantId}`,
        file_type: 'markdown',
        source: `${DOC_PREFIX}.md`,
        status: 'ready',
        chunk_count: 0,
      });
    }
  });

  afterAll(async () => {
    await Document.destroy({ where: { title: { [Op.like]: `${DOC_PREFIX}%` } } });
  });

  it('有租户上下文时，不带过滤的查询只返回本租户的行', async () => {
    const seen = await runWithTenant(acmeId, async () => {
      const rows = await Document.findAll();
      return rows.map((r) => r.tenant_id);
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set([acmeId]));
    // globex 的那条不该出现
    expect(seen).not.toContain(globexId);
  });

  it('切到另一个租户，看到的是另一个租户的行', async () => {
    const seen = await runWithTenant(globexId, async () => {
      const rows = await Document.findAll();
      return rows.map((r) => r.tenant_id);
    });
    expect(new Set(seen)).toEqual(new Set([globexId]));
    expect(seen).not.toContain(acmeId);
  });

  it('显式查别的租户 → 抛 TenantIsolationError（不静默放行）', async () => {
    await expect(
      runWithTenant(acmeId, async () => {
        await Document.findAll({ where: { tenant_id: globexId } });
      }),
    ).rejects.toThrow(TenantIsolationError);
  });

  it('没有租户上下文时不受限（平台方视角 —— 跨租户统计就靠这个）', async () => {
    const rows = await Document.findAll();
    const tenants = new Set(rows.map((r) => r.tenant_id));
    expect(tenants.size).toBeGreaterThanOrEqual(2);
    expect(tenants.has(acmeId)).toBe(true);
    expect(tenants.has(globexId)).toBe(true);
  });

  it('上下文里已有本租户的过滤条件时不会被改写', async () => {
    const rows = await runWithTenant(acmeId, async () => {
      return Document.findAll({ where: { tenant_id: acmeId, status: 'ready' } });
    });
    expect(rows.every((r) => r.tenant_id === acmeId)).toBe(true);
  });

  it('count 也受作用域约束（beforeCount 钩子）', async () => {
    const acmeScoped = await runWithTenant(acmeId, async () => Document.count());
    const globexScoped = await runWithTenant(globexId, async () => Document.count());
    // 显式加过滤的计数 —— 作用域版必须跟它一致
    const acmeExplicit = await Document.count({ where: { tenant_id: acmeId } });
    const globexExplicit = await Document.count({ where: { tenant_id: globexId } });

    expect(acmeScoped).toBe(acmeExplicit);
    expect(globexScoped).toBe(globexExplicit);
    expect(acmeScoped).toBeGreaterThan(0);
    expect(globexScoped).toBeGreaterThan(0);
  });
});
