import { Umzug, SequelizeStorage, type MigrationParams } from 'umzug';
import type { QueryInterface } from 'sequelize';
import { getSequelize } from '../db';
import { logger } from '../logger';

/**
 * umzug 迁移 runner（详见 docs/03-技术栈与规范.md §B.2）
 * - 从 src/migrations/*.ts 自动发现
 * - 已执行的迁移写 `sequelize_meta` 表
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
    migrations: {
      glob: [
        'src/migrations/*.ts',
        { cwd: process.cwd(), ignore: ['**/index.ts', '**/runner.ts'] },
      ],
      resolve: ({ name, path: migrationPath, context }: MigrationParams<QueryInterface>) => {
        // 用 require 动态加载 umzug 传来的迁移文件路径
        const resolvedPath = migrationPath as string;
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require(resolvedPath) as {
          up: (qi: QueryInterface) => Promise<void>;
          down: (qi: QueryInterface) => Promise<void>;
        };
        return {
          name,
          up: async () => mod.up(context),
          down: async () => mod.down(context),
        };
      },
    },
  });
}
