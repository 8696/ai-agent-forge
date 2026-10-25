import { describe, it, expect } from 'vitest';
import { applyTenantScope } from '../../src/lib/tenant-scope';
import { TenantIsolationError } from '../../src/lib/errors';
import type { ModelStatic, Model } from 'sequelize';

/**
 * 租户作用域钩子的纯逻辑测试 —— docs/12-a-需求-多租户与登录.md §A1
 *
 * 测的是 `applyTenantScope` 本身（不碰数据库）——
 * 集成层面的验证见 tests/integration/tenant-scope.test.ts。
 */

/** 造一个「带 tenant_id 列」的假模型 */
function fakeModel(withTenantColumn: boolean): ModelStatic<Model> {
  const rawAttributes = withTenantColumn ? { tenant_id: {} } : {};
  return { name: 'FakeModel', rawAttributes } as unknown as ModelStatic<Model>;
}

const WITH_TENANT = fakeModel(true);
const WITHOUT_TENANT = fakeModel(false);

describe('租户作用域 · 运行时强制（A1）', () => {
  it('where 缺失时补上当前租户', () => {
    const options: { where?: unknown } = {};
    applyTenantScope(options, WITH_TENANT, 'tenant-a');
    expect(options.where).toEqual({ tenant_id: 'tenant-a' });
  });

  it('where 里没有租户键时补上当前租户', () => {
    const options: { where?: unknown } = { where: { id: 'x' } };
    applyTenantScope(options, WITH_TENANT, 'tenant-a');
    expect(options.where).toEqual({ id: 'x', tenant_id: 'tenant-a' });
  });

  it('where 里已经是当前租户时不动', () => {
    const options: { where?: unknown } = { where: { tenant_id: 'tenant-a', id: 'x' } };
    applyTenantScope(options, WITH_TENANT, 'tenant-a');
    expect(options.where).toEqual({ tenant_id: 'tenant-a', id: 'x' });
  });

  it('where 里写了别的租户 → 抛错（不静默放行）', () => {
    const options: { where?: unknown } = { where: { tenant_id: 'tenant-b' } };
    expect(() => applyTenantScope(options, WITH_TENANT, 'tenant-a')).toThrow(TenantIsolationError);
  });

  it('没有租户上下文时不动（平台方视角 / 启动期任务）', () => {
    const options: { where?: unknown } = { where: { id: 'x' } };
    applyTenantScope(options, WITH_TENANT, undefined);
    expect(options.where).toEqual({ id: 'x' });
  });

  it('租户上下文是空串时视为没有上下文', () => {
    const options: { where?: unknown } = { where: { id: 'x' } };
    applyTenantScope(options, WITH_TENANT, '');
    expect(options.where).toEqual({ id: 'x' });
  });

  it('模型没有 tenant_id 列时不动（Tenant / SystemUser 这种）', () => {
    const options: { where?: unknown } = { where: { id: 'x' } };
    applyTenantScope(options, WITHOUT_TENANT, 'tenant-a');
    expect(options.where).toEqual({ id: 'x' });
  });

  it('where 是数组时不动（形状不认识，宁可漏拦也不改坏 SQL）', () => {
    const where = [{ id: 'x' }];
    const options: { where?: unknown } = { where };
    applyTenantScope(options, WITH_TENANT, 'tenant-a');
    expect(options.where).toBe(where);
  });

  it('where 是 Op 条件（不是字符串）时不比较、不报错', () => {
    const where = { tenant_id: { [Symbol.for(' SequelizeOp.ne')]: 'tenant-b' } };
    const options: { where?: unknown } = { where };
    applyTenantScope(options, WITH_TENANT, 'tenant-a');
    expect(options.where).toBe(where);
  });

  it('注入不会破坏原有的 where 条件', () => {
    const options: { where?: unknown } = {
      where: { status: 'ready', created_at: { gte: 1 } },
    };
    applyTenantScope(options, WITH_TENANT, 'tenant-a');
    expect(options.where).toEqual({
      status: 'ready',
      created_at: { gte: 1 },
      tenant_id: 'tenant-a',
    });
  });
});
