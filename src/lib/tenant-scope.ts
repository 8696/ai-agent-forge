import type { Model, ModelStatic } from 'sequelize';
import type { Sequelize as SequelizeType } from 'sequelize-typescript';
import { config } from '../config';
import { logger } from '../logger';
import { currentTenantId } from './tenant-context';
import { TenantIsolationError } from './errors';

/** 任意模型类（钩子只用到 rawAttributes 和 name，不需要具体泛型） */
type AnyModel = ModelStatic<Model>;

/**
 * 租户作用域的**运行时强制** —— docs/12-a-需求-多租户与登录.md §A1
 *
 * ## 定位
 *
 * A1 的验收原文：「直接 `Document.findAll()`（不带 scope）应该有警告或被 lint 禁止」。
 * 本项目 `yarn lint` 跑不起来（typescript-eslint 不支持 TypeScript 7），
 * 所以先落了一条**静态约束测试**（`tests/unit/tenant-isolation-guard.test.ts`）。
 *
 * 但静态测试有三个绕不过去的洞：
 *   1. 它扫的是「源码里出现了 tenant_id 这个词」，不是「查的是不是本租户」
 *   2. 它靠正则匹配方法名，新增一个查询方法名就漏（`findAndCountAll` / `bulkCreate` 就漏过）
 *   3. 它管不到运行时 —— 白名单登记错了、helper 改坏了，功能测试里根本看不出来
 *
 * 所以再加一层**运行时强制**：把租户 id 放进请求级上下文（`tenant-context.ts`），
 * 再由 Sequelize 的全局钩子在查询发出前自动补上 `tenant_id` 过滤。
 * **人不用记得加过滤** —— 忘了也不会跨租户。
 *
 * ## 三条互补的防线
 *
 *   1. 运行时钩子（本文件）—— 兜住「忘了加过滤」这个最常见的 bug
 *   2. 静态约束测试 —— 兜住「查询形状不对」（数组 where / 顶层 Op.or 这类）
 *   3. 代码评审 —— 兜住「这个查询本来就不该带租户过滤」（登记到白名单）
 *
 * ## 三种上下文下的行为
 *
 * | 场景                       | 上下文里有租户吗 | 行为                                   |
 * | -------------------------- | ---------------- | -------------------------------------- |
 * | admin / customer / 对外 API | 有               | 自动补 `tenant_id`；显式写了别的租户 → **抛错** |
 * | system（平台方）            | **没有**         | 不动 —— 平台方本来就要跨租户看数据        |
 * | 启动期 / 后台任务 / 测试     | 没有             | 不动                                   |
 */
const TENANT_COLUMN = 'tenant_id';

/** 模型是否带 tenant_id 列（只有带了的才需要作用域） */
function hasTenantColumn(model: AnyModel): boolean {
  const m = model as unknown as { rawAttributes?: Record<string, unknown> };
  return m.rawAttributes !== undefined && m.rawAttributes[TENANT_COLUMN] !== undefined;
}

/**
 * where 里已经有的 tenant_id 是不是「当前租户」。
 *
 * 只在**值是字符串**时能判定 —— `tenant_id: { [Op.ne]: 'x' }` 这类条件
 * 没法跟当前租户比较，遇到这种就放行（由静态约束测试去管形状）。
 */
function explicitTenantId(where: Record<string, unknown>): string | undefined {
  const v = where[TENANT_COLUMN];
  return typeof v === 'string' ? v : undefined;
}

/**
 * 给一次查询补上租户过滤（或校验已有的过滤）。
 *
 * 挂在四个钩子上：
 *   - `beforeFind`        —— findAll / findOne / findByPk / findAndCountAll
 *   - `beforeCount`       —— count
 *   - `beforeBulkUpdate`  —— Model.update
 *   - `beforeBulkDestroy` —— Model.destroy
 *
 * ⚠️ **`Model.aggregate` / `Model.sum` 不触发任何钩子** —— Sequelize 没有对应钩子。
 *    目前全仓只有一处用到（平台方跨租户统计成本，本来就该跨租户），不受影响。
 */
export function applyTenantScope(
  options: { where?: unknown },
  model: AnyModel,
  tenantId: string | undefined,
): void {
  if (!config.TENANT_SCOPE.ENFORCE) {
    return;
  }
  if (tenantId === undefined || tenantId === '') {
    // 没有租户上下文 → 这是一次平台级 / 启动期查询，不加过滤
    return;
  }
  if (!hasTenantColumn(model)) {
    return;
  }

  const where = options.where;

  if (where === undefined || where === null) {
    options.where = { [TENANT_COLUMN]: tenantId };
    return;
  }

  if (typeof where !== 'object' || Array.isArray(where)) {
    // 不认识的形状（数组 where / 顶层 Op.or）—— 不动它。
    // 宁可漏拦，也不要把一条本来能跑的 SQL 改坏。
    // 这种形状由静态约束测试负责（见 tenant-isolation-guard.test.ts）。
    logger.warn(
      { model: model.name, tenantId },
      '查询的 where 不是普通对象，租户作用域无法自动补全 —— 请手动加 tenant_id',
    );
    return;
  }

  const record = where as Record<string, unknown>;
  const existing = explicitTenantId(record);
  if (existing !== undefined) {
    if (existing !== tenantId) {
      // ⚠️ 显式查了别的租户 —— 这是越权，不是笔误。宁可报错也不放行。
      throw new TenantIsolationError(
        `查询试图跨租户：模型 ${model.name} 的 tenant_id 是 ${existing}，当前租户是 ${tenantId}`,
      );
    }
    return; // 已经是本租户了，不动
  }

  if (Object.prototype.hasOwnProperty.call(record, TENANT_COLUMN)) {
    // 有 tenant_id 但不是字符串（Op 条件）—— 没法比较，放行
    return;
  }

  record[TENANT_COLUMN] = tenantId;
}

/**
 * 给所有带 tenant_id 列的模型装上租户作用域钩子。
 *
 * 在 `src/db.ts` 里 `addModels` 之后调一次。
 */
export function installTenantScopeHooks(sequelize: SequelizeType): void {
  let count = 0;
  for (const model of Object.values(sequelize.models) as AnyModel[]) {
    if (!hasTenantColumn(model)) {
      continue;
    }
    const guard = (options: { where?: unknown }): void => {
      applyTenantScope(options, model, currentTenantId());
    };
    model.addHook('beforeFind', guard);
    model.addHook('beforeCount', guard);
    model.addHook('beforeBulkUpdate', guard);
    model.addHook('beforeBulkDestroy', guard);
    count += 1;
  }
  logger.info({ models: count }, '租户作用域钩子已安装');
}
