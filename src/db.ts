import { DataTypes, type Sequelize } from 'sequelize';
import { Sequelize as SequelizeType } from 'sequelize-typescript';
import { config } from './config';
import { logger } from './logger';
import { Tenant } from './models/Tenant';
import { User } from './models/User';

/**
 * Sequelize 实例（单例）。
 * 详见 docs/13-后端代码示例.md §13.1
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
  instance.addModels([Tenant, User]);
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
