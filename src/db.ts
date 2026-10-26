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
import { probeApiKeySha256Column } from './lib/api-key-auth';
import { probeUserMemoryEmbeddingColumns } from './services/memory-relevance';

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

  // ⚠️ **迁移 034（api_keys.key_sha256）跑了没** —— 没跑的话要降级，
  //    否则**每一次**对 api_keys 的查询都会报「Unknown column 'key_sha256'」：
  //    Sequelize 的 SELECT 列清单来自模型定义，不是查询里写了什么。
  //    探一次、把列摘掉，一次性解决所有路径（鉴权 + 后台的 key 列表 / 改权限 / 撤销）。
  //    详见 src/lib/api-key-auth.ts 的 probeApiKeySha256Column。
  await probeApiKeySha256Column();

  // ⚠️ **迁移 035（user_memories.embedding）跑了没** —— 同理：
  //    列不存在时每一次对 user_memories 的查询都会报「Unknown column 'embedding'」
  //    （记忆列表 / 计数 / 归档 全挂）。
  //    探一次、把两列摘掉，记忆退回固定顺序的注入排序，功能少一半但不影响使用。
  //    详见 src/services/memory-relevance.ts 的 probeUserMemoryEmbeddingColumns。
  await probeUserMemoryEmbeddingColumns();
}

// 重导出 DataTypes / Sequelize 类型，给后续 migration 用
export { DataTypes };
export type { Sequelize };
