import 'reflect-metadata';
import Koa from 'koa';
import bodyParser from 'koa-bodyparser';
import cors from '@koa/cors';
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
  systemAuditRouter,
  adminUserRouter,
  adminAuthRouter,
  adminKnowledgeRouter,
  adminConfigRouter,
  adminObservabilityRouter,
  adminEvaluationRouter,
  adminMemoryRouter,
  adminAuditRouter,
  adminToolRouter,
  adminToolLogRouter,
  customerAuthRouter,
  customerChatRouter,
  customerMemoryRouter,
  customerProfileRouter,
  customerKnowledgeRouter,
  publicWidgetRouter,
  publicApiRouter,
  publicAdminApiRouter,
  publicApiKeyAdminRouter,
} from './gateway';
import { rebuildFromQdrant } from './rag/bm25';
import { ensureCollection } from './rag/qdrant';

/**
 * 后端入口 —— 详见 docs/13-扩展指南.md Step 1 + 02-系统架构与目录.md §2.1
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
      // X-Widget-Token / X-API-Key：E1 的两条对外链路用的自定义头，
      // 浏览器跨域调用时必须显式允许，否则预检请求会被拦掉。
      allowHeaders: ['Content-Type', 'Authorization', 'X-Widget-Token', 'X-API-Key'],
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
  app.use(systemTenantRouter.routes()).use(systemTenantRouter.allowedMethods()); // system 租户管理
  app.use(systemAuthRouter.routes()).use(systemAuthRouter.allowedMethods()); // system login
  app.use(systemAuditRouter.routes()).use(systemAuditRouter.allowedMethods()); // system 审计日志（跨租户）
  app.use(adminUserRouter.routes()).use(adminUserRouter.allowedMethods()); // admin 用户管理
  app.use(adminAuthRouter.routes()).use(adminAuthRouter.allowedMethods()); // admin login
  app.use(
    adminKnowledgeRouter.routes(),
  ).use(adminKnowledgeRouter.allowedMethods()); // admin 知识库（文档 + 检索）
  app.use(
    adminConfigRouter.routes(),
  ).use(adminConfigRouter.allowedMethods()); // admin 模型 & 提示词配置
  app.use(
    adminObservabilityRouter.routes(),
  ).use(adminObservabilityRouter.allowedMethods()); // admin 观测（trace / 成本）
  app.use(
    adminEvaluationRouter.routes(),
  ).use(adminEvaluationRouter.allowedMethods()); // admin 评测（评测集 / 跑批）
  app.use(
    adminMemoryRouter.routes(),
  ).use(adminMemoryRouter.allowedMethods()); // admin 用户记忆（B4）
  app.use(adminAuditRouter.routes()).use(adminAuditRouter.allowedMethods()); // admin 审计日志
  app.use(adminToolRouter.routes()).use(adminToolRouter.allowedMethods()); // admin 工具注册表（C2）
  app.use(adminToolLogRouter.routes()).use(adminToolLogRouter.allowedMethods()); // admin 工具调用记录
  app.use(customerAuthRouter.routes()).use(customerAuthRouter.allowedMethods()); // customer login
  app.use(customerChatRouter.routes()).use(customerChatRouter.allowedMethods()); // customer 对话（SSE）
  app.use(
    customerMemoryRouter.routes(),
  ).use(customerMemoryRouter.allowedMethods()); // customer 我的记忆（B4）
  app.use(
    customerProfileRouter.routes(),
  ).use(customerProfileRouter.allowedMethods()); // customer 租户信息 + 首页配置（B7）
  app.use(
    customerKnowledgeRouter.routes(),
  ).use(customerKnowledgeRouter.allowedMethods()); // customer 知识库文档概览（B7）

  // ===== 对外接入（E1）=====
  // 公开挂件（免登录，匿名会话 token）+ 对外 REST API（API Key 鉴权）
  app.use(publicWidgetRouter.routes()).use(publicWidgetRouter.allowedMethods());
  app.use(publicApiRouter.routes()).use(publicApiRouter.allowedMethods());
  // 对外 REST API 的 admin 档（知识库管理：文档列表 / 上传 / 删除）
  // ⚠️ 排在 publicApiRouter 之后 —— 两个 router 共用 /api/v1/public 前缀，
  //    但路径不重叠（/search /chat /chat/stream vs /documents）。
  app.use(publicAdminApiRouter.routes()).use(publicAdminApiRouter.allowedMethods());
  // 租户后台管理自己的 API Key（admin JWT 鉴权；URL 属于 admin 命名空间）
  app.use(publicApiKeyAdminRouter.routes()).use(publicApiKeyAdminRouter.allowedMethods());

  // 数据库初始化（缺配置 + 启动 DB 失败都不让起来）
  await initDatabase();

  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT, env: config.NODE_ENV }, '🚀 AgentPlatform 后端启动');
  });

  // BM25 索引只活在内存里，重启后从 Qdrant 的 payload 重建。
  // 后台跑且不 await：Qdrant 不可用 / 数据量大时都不该拖住启动；
  // 重建期间检索测试页只有向量一路结果，完成后自动变成混合检索。
  void rebuildFromQdrant();

  /**
   * 保证 Qdrant collection + payload 索引就位。
   *
   * ⚠️ 2026-10-27 加的：payload 索引（尤其 `chunk_index` 的 integer 索引）
   *    是「后台切片浏览页按块序号排序」的**硬前提** —— 缺了 Qdrant 直接 400。
   *    而索引以前只在「上传时」才建（`upsertDocumentChunks` → `ensureCollection`），
   *    只读端点用不上 → 所以这里在启动时也确保一次。
   *
   * 后台跑且不 await：Qdrant 不可用时不该拖住启动（切片浏览页会退化成「加载失败」）。
   */
  void ensureCollection().catch((err: unknown) => {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'Qdrant collection / payload 索引初始化失败',
    );
  });

  // 优雅退出
  const shutdown = (signal: string): void => {
    logger.info({ signal }, '收到退出信号，正在关闭服务');
    server.close(() => {
      logger.info('HTTP服务已关闭');
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
