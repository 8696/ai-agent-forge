import { DataTypes, type Sequelize } from 'sequelize';
import { Sequelize as SequelizeType } from 'sequelize-typescript';
import { config } from './config';
import { logger } from './logger';
import { Tenant } from './models/Tenant';
import { User } from './models/User';
import { UserMemory } from './models/UserMemory';
import { SystemUser } from './models/SystemUser';
import { ApiKey } from './models/ApiKey';
import { Document } from './models/Document';
import { Session } from './models/Session';
import { Message } from './models/Message';
import { PromptVersion } from './models/PromptVersion';
import { TenantModel } from './models/TenantModel';
import { TenantSetting } from './models/TenantSetting';
import { AuditLog } from './models/AuditLog';
import { CostLog } from './models/CostLog';
import { Trace } from './models/Trace';
import { Span } from './models/Span';
import { EvaluationDataset } from './models/EvaluationDataset';
import { EvaluationItem } from './models/EvaluationItem';
import { EvaluationRun } from './models/EvaluationRun';
import { EvaluationResult } from './models/EvaluationResult';
import { Tool } from './models/Tool';
import { ToolCallLog } from './models/ToolCallLog';
import { Mission } from './models/Mission';
import { AgentRun } from './models/AgentRun';
import { AgentStep } from './models/AgentStep';
import { installTenantScopeHooks } from './lib/tenant-scope';

/**
 * Sequelize 实例（单例）。
 * 详见 docs/03-b-技术栈-后端栈.md §13.1
 */
let sequelizeInstance: SequelizeType | null = null;

function buildSequelize(): SequelizeType {
  const { MYSQL } = config;
  const instance = new SequelizeType({
    dialect: 'mysql',
    host: MYSQL.HOST,
    port: MYSQL.PORT,
    username: MYSQL.USER,
    password: MYSQL.PASSWORD,
    database: MYSQL.DB,
    logging: false, // 由 pino 统一管日志
    define: {
      charset: 'utf8mb4',
      collate: 'utf8mb4_unicode_ci',
      timestamps: true,
    },
    pool: {
      max: 10,
      min: 0,
      acquire: 30000,
      idle: 10000,
    },
  });

  // 注册模型：每加一个 model 在此注册（以后会更多）
  instance.addModels([
  Tenant,
  User,
  UserMemory,
  SystemUser,
  ApiKey,
  Document,
  Session,
  Message,
  PromptVersion,
  TenantModel,
  TenantSetting,
  AuditLog,
  CostLog,
  Trace,
  Span,
  EvaluationDataset,
  EvaluationItem,
  EvaluationRun,
  EvaluationResult,
  Tool,
  ToolCallLog,
  Mission,
  AgentRun,
  AgentStep,
]);

  // 租户作用域的运行时强制（A1）：给每个带 tenant_id 列的模型装上查询钩子，
  // 请求上下文里有租户时自动补过滤 —— 见 src/lib/tenant-scope.ts
  installTenantScopeHooks(instance);

  return instance;
}

export function getSequelize(): SequelizeType {
  if (sequelizeInstance === null) {
    sequelizeInstance = buildSequelize();
  }
  return sequelizeInstance;
}

export const sequelize = getSequelize();

/**
 * 仅在 server boot 时调用：连接 + 鉴权，不自动建表（建表由 umzug 迁移负责）。
 */
export async function initDatabase(): Promise<void> {
  try {
    await sequelize.authenticate();
    logger.info('数据库连接成功');
  } catch (err) {
    logger.error({ err }, '数据库连接失败');
    throw err;
  }
}

// 重导出 DataTypes / Sequelize 类型，给后续 migration 用
export { DataTypes };
export type { Sequelize };
