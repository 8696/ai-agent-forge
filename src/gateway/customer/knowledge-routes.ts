import Router from '@koa/router';
import type { Context } from 'koa';
import { z } from 'zod';
import { jwtAuth } from '../jwt-base';
import { requireCustomer } from './middleware';
import { Document } from '../../models';
import type { TenantUserJwtPayload } from '../../lib/jwt';

/**
 * customer 子系统：知识库文档概览 —— 前台首页工作台
 * 详见 docs/12-b-需求-ai对话能力.md §B7
 *
 * 路由前缀：/api/v1/customer　鉴权：customer 角色（jwtAuth + requireCustomer）
 *
 * 端点：
 *   GET /documents   本租户知识库有哪些资料（只读元信息）
 *
 * ## 只读、只给元信息
 * 这个端点**不返回** `file_path` / `source`（磁盘文件名）/ `error_message`：
 *  - file_path 是服务器绝对路径，泄露了等于把部署结构交出去
 *  - source 是磁盘上的存储文件名，同样不该给前台
 *  - error_message 是给 admin 看的排障摘要，可能带着解析器的内部报错
 * 前台只需要知道「有哪些资料、能不能用」，不需要知道东西存在哪。
 *
 * ## 跨租户隔离
 * where 里强制带 JWT 里的 tenant_id，前端传什么都不作数。
 *
 * ## 这不是「给前台用户开放上传」
 * 上传仍然只有 admin 能做（`/api/v1/admin/knowledge/upload`）——
 * 前台用户看到的是「我们公司的资料清单」，不是「往知识库里塞东西」的入口。
 */

export const customerKnowledgeRouter = new Router({ prefix: '/api/v1/customer' });

customerKnowledgeRouter.use(jwtAuth, requireCustomer);

const listQuerySchema = z.object({
  /** 首页概览只要前几份；上限 50 防止被当成「导出文档清单」用 */
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

/** 取当前 customer —— 中间件已经保证一定存在且是 customer 角色 */
function currentUser(ctx: Context): TenantUserJwtPayload {
  return ctx.state.customerUser as TenantUserJwtPayload;
}

customerKnowledgeRouter.get('/documents', async (ctx) => {
  const u = currentUser(ctx);
  const input = listQuerySchema.parse(ctx.query);

  const { rows, count } = await Document.findAndCountAll({
    where: { tenant_id: u.tenant_id },
    attributes: ['id', 'title', 'file_type', 'status', 'chunk_count', 'updated_at'],
    order: [['uploaded_at', 'DESC']],
    limit: input.limit,
  });

  ctx.body = {
    documents: rows.map((d) => ({
      id: d.id,
      title: d.title,
      file_type: d.file_type,
      status: d.status,
      chunk_count: d.chunk_count,
      updated_at: d.updated_at.toISOString(),
    })),
    /** 本租户知识库里的资料总数（不限本次返回了几条） */
    total: count,
  };
});
