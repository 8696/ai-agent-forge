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
import * as m008 from './008-converge-documents-schema';
import * as m009 from './009-create-sessions-messages';
import * as m010 from './010-create-prompt-versions-llm-config';
import * as m011 from './011-add-tenant-chat-params';
import * as m012 from './012-split-tenant-chat-settings';
import * as m013 from './013-restructure-tenant-config';
import * as m014 from './014-create-cost-logs';
import * as m015 from './015-create-traces-spans';
import * as m016 from './016-create-evaluation';
import * as m017 from './017-create-user-memories';
import * as m018 from './018-add-tenant-model-usage-scope';
import * as m019 from './019-add-tenant-model-summary-scope';
import * as m020 from './020-add-api-key-scope';
import * as m021 from './021-alter-documents-file-type';
import * as m022 from './022-create-tools';
import * as m023 from './023-messages-parts-column';
import * as m024 from './024-create-tool-call-logs';
import * as m025 from './025-add-tool-call-rejected';
import * as m026 from './026-add-tool-updated-by';
import * as m027 from './027-normalize-charset';
import * as m028 from './028-create-missions';
import * as m029 from './029-tool-call-logs-blocked-status';
import * as m030 from './030-add-tenant-model-fallback';
import * as m031 from './031-add-session-favorite';
import * as m032 from './032-create-agent-runs';
import * as m033 from './033-evaluation-run-trigger';
import * as m034 from './034-add-api-key-sha256';

/**
 * umzug 迁移 runner（详见 docs/03-b-技术栈-后端栈.md §B.2）
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
      {
        name: '008-converge-documents-schema',
        up: (params) => m008.up(params),
        down: (params) => m008.down(params),
      },
      {
        name: '009-create-sessions-messages',
        up: (params) => m009.up(params),
        down: (params) => m009.down(params),
      },
      {
        name: '010-create-prompt-versions-llm-config',
        up: (params) => m010.up(params),
        down: (params) => m010.down(params),
      },
      {
        name: '011-add-tenant-chat-params',
        up: (params) => m011.up(params),
        down: (params) => m011.down(params),
      },
      {
        name: '012-split-tenant-chat-settings',
        up: (params) => m012.up(params),
        down: (params) => m012.down(params),
      },
      {
        name: '013-restructure-tenant-config',
        up: (params) => m013.up(params),
        down: (params) => m013.down(params),
      },
      {
        name: '014-create-cost-logs',
        up: (params) => m014.up(params),
        down: (params) => m014.down(params),
      },
      {
        name: '015-create-traces-spans',
        up: (params) => m015.up(params),
        down: (params) => m015.down(params),
      },
      {
        name: '016-create-evaluation',
        up: (params) => m016.up(params),
        down: (params) => m016.down(params),
      },
      {
        name: '017-create-user-memories',
        up: (params) => m017.up(params),
        down: (params) => m017.down(params),
      },
      {
        name: '018-add-tenant-model-usage-scope',
        up: (params) => m018.up(params),
        down: (params) => m018.down(params),
      },
      {
        name: '019-add-tenant-model-summary-scope',
        up: (params) => m019.up(params),
        down: (params) => m019.down(params),
      },
      {
        name: '020-add-api-key-scope',
        up: (params) => m020.up(params),
        down: (params) => m020.down(params),
      },
      {
        name: '021-alter-documents-file-type',
        up: (params) => m021.up(params),
        down: (params) => m021.down(params),
      },
      {
        name: '022-create-tools',
        up: (params) => m022.up(params),
        down: (params) => m022.down(params),
      },
      {
        name: '023-messages-parts-column',
        up: (params) => m023.up(params),
        down: (params) => m023.down(params),
      },
      {
        name: '024-create-tool-call-logs',
        up: (params) => m024.up(params),
        down: (params) => m024.down(params),
      },
      {
        name: '025-add-tool-call-rejected',
        up: (params) => m025.up(params),
        down: (params) => m025.down(params),
      },
      {
        name: '026-add-tool-updated-by',
        up: (params) => m026.up(params),
        down: (params) => m026.down(params),
      },
      {
        name: '027-normalize-charset',
        up: (params) => m027.up(params),
        down: (params) => m027.down(params),
      },
      {
        name: '028-create-missions',
        up: (params) => m028.up(params),
        down: (params) => m028.down(params),
      },
      {
        name: '029-tool-call-logs-blocked-status',
        up: (params) => m029.up(params),
        down: (params) => m029.down(params),
      },
      {
        name: '030-add-tenant-model-fallback',
        up: (params) => m030.up(params),
        down: (params) => m030.down(params),
      },
      {
        name: '031-add-session-favorite',
        up: (params) => m031.up(params),
        down: (params) => m031.down(params),
      },
      {
        name: '032-create-agent-runs',
        up: (params) => m032.up(params),
        down: (params) => m032.down(params),
      },
      {
        name: '033-evaluation-run-trigger',
        up: (params) => m033.up(params),
        down: (params) => m033.down(params),
      },
      {
        name: '034-add-api-key-sha256',
        up: (params) => m034.up(params),
        down: (params) => m034.down(params),
      },
    ],
  });
}
