import { DataTypes, type QueryInterface } from 'sequelize';
import type { MigrationFn } from 'umzug';
import { listColumns, tableExists } from './helpers/schema';

/**
 * tools 表加 `updated_by`（谁改的）
 *
 * `created_by`（谁注册的）建表时就有，但改的人没记 ——
 * 其他 admin 可写的表（tenant_models.updated_by / prompt_versions.created_by /
 * api_keys.created_by）都记了操作人，工具表漏了。
 *
 * 幂等：列已存在就跳过。
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  if (!(await tableExists(queryInterface, 'tools'))) {
    return;
  }
  const columns = await listColumns(queryInterface, 'tools');
  if (columns.has('updated_by')) {
    return;
  }
  await queryInterface.addColumn('tools', 'updated_by', {
    type: DataTypes.STRING(36),
    allowNull: true,
    comment: '最后修改人 user id',
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  if (!(await tableExists(queryInterface, 'tools'))) {
    return;
  }
  const columns = await listColumns(queryInterface, 'tools');
  if (!columns.has('updated_by')) {
    return;
  }
  await queryInterface.removeColumn('tools', 'updated_by');
};
