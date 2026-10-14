import { Umzug, SequelizeStorage } from 'umzug';
import type { QueryInterface } from 'sequelize';
import { getSequelize } from '../db';
import { logger } from '../logger';
import * as m001 from './001-create-tenants';
import * as m002 from './002-create-users';
import * as m003 from './003-create-system-users';
import * as m004 from './004-create-api-keys';
import * as m005 from './005-add-tenant-status-expires';
import * as m006 from './006-create-audit-logs';
import * as m007 from './007-create-documents';

/**
 * umzug 迁移 runner（详见 docs/03-技术栈与规范.md §B.2）
 * - 显式列出迁移文件（静态 import 保证 tsx 能正确解析 .ts）
 * - 已执行的迁移写 `sequelize_meta` 表
 *
 * 加新迁移：在此 import + push 进 migrations 数组
 */
export function buildMigrator(): Umzug<QueryInterface> {
  const sequelize = getSequelize();
  return new Umzug({
    storage: new SequelizeStorage({ sequelize, tableName: 'sequelize_meta' }),
    context: sequelize.getQueryInterface(),
    logger: {
      info: (msg: Record<string, unknown>) => logger.info({ umzug: msg }, 'migration'),
      warn: (msg: Record<string, unknown>) => logger.warn({ umzug: msg }, 'migration'),
      error: (msg: Record<string, unknown>) => logger.error({ umzug: msg }, 'migration'),
      debug: (msg: Record<string, unknown>) => logger.debug({ umzug: msg }, 'migration'),
    },
    migrations: [
      {
        name: '001-create-tenants',
        up: (params) => m001.up(params),
        down: (params) => m001.down(params),
      },
      {
        name: '002-create-users',
        up: (params) => m002.up(params),
        down: (params) => m002.down(params),
      },
      {
        name: '003-create-system-users',
        up: (params) => m003.up(params),
        down: (params) => m003.down(params),
      },
      {
        name: '004-create-api-keys',
        up: (params) => m004.up(params),
        down: (params) => m004.down(params),
      },
      {
        name: '005-add-tenant-status-expires',
        up: (params) => m005.up(params),
        down: (params) => m005.down(params),
      },
      {
        name: '006-create-audit-logs',
        up: (params) => m006.up(params),
        down: (params) => m006.down(params),
      },
      {
        name: '007-create-documents',
        up: (params) => m007.up(params),
        down: (params) => m007.down(params),
      },
    ],
  });
}
