import 'reflect-metadata';
import Koa from 'koa';
import bodyParser from 'koa-bodyparser';
import cors from '@koa/cors';
import { promises as fs } from 'fs';
import path from 'path';
import { config } from './config';
import { logger } from './logger';
import { initDatabase } from './db';
import {
  errorHandler,
  healthRouter,
  activeConfigRouter,
  devProbeRouter,
  systemTenantRouter,
  systemAuthRouter,
  adminUserRouter,
  adminAuthRouter,
  adminKnowledgeRouter,
  customerAuthRouter,
} from './gateway';

/**
 * 后端入口 —— 详见 docs/15-开发进度计划.md Step 1 + 02-系统架构与目录.md §2.1
 */
async function bootstrap(): Promise<void> {
  const app = new Koa();
  app.proxy = true;

  // 全局中间件：先放错误兜底，再放 CORS + bodyparser
  app.use(errorHandler);
  app.use(
    cors({
      origin: '*',
      credentials: true,
      // SSE 需要长连接
      allowHeaders: ['Content-Type', 'Authorization'],
    }),
  );
  app.use(bodyParser({ jsonLimit: '4mb', enableTypes: ['json', 'form'] }));

  // 健康检查
  app.use(healthRouter.routes()).use(healthRouter.allowedMethods());

  // 公共「当前激活配置」端点（页脚展示 LLM / Embedding 模型用，无鉴权）
  app.use(activeConfigRouter.routes()).use(activeConfigRouter.allowedMethods());

  // Dev-only 探活路由（生产环境内部 404，仅本地调试用）
  app.use(devProbeRouter.routes()).use(devProbeRouter.allowedMethods());

  // 业务路由（3 子系统各自独立，auth 自闭环）
  app.use(systemTenantRouter.routes()).use(systemTenantRouter.allowedMethods()); // systems 子系统
  app.use(systemAuthRouter.routes()).use(systemAuthRouter.allowedMethods()); // systems login + me + change-password
  app.use(adminUserRouter.routes()).use(adminUserRouter.allowedMethods()); // admin 业务（用户管理）
  app.use(adminKnowledgeRouter.routes()).use(adminKnowledgeRouter.allowedMethods()); // admin 知识库（Step 4）
  app.use(adminAuthRouter.routes()).use(adminAuthRouter.allowedMethods()); // admin login + me + change-password
  app.use(customerAuthRouter.routes()).use(customerAuthRouter.allowedMethods()); // customer login + me + change-password

  // 数据库初始化（缺配置 + 启动 DB 失败都不让起来）
  await initDatabase();

  // Step 4：知识库本地目录自举（koa-body multipart 落盘 + 上传文件落 ./data/uploads）
  await fs.mkdir(path.resolve(config.DATA_DIR, 'tmp'), { recursive: true });
  await fs.mkdir(path.resolve(config.DATA_DIR, 'uploads'), { recursive: true });

  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT, env: config.NODE_ENV }, '🚀 AgentPlatform 后端启动');
  });

  // 优雅退出
  const shutdown = (signal: string): void => {
    logger.info({ signal }, '收到退出信号，正在关闭服务');
    server.close(() => {
      logger.info('HTTP 服务已关闭');
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

bootstrap().catch((err: unknown) => {
  logger.error({ err }, '启动失败');
  process.exit(1);
});
