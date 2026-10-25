import Router from '@koa/router';
import type { Context } from 'koa';
import { jwtAuth } from '../jwt-base';
import { requireCustomer } from './middleware';
import { Tenant } from '../../models';
import { getSettingValues, parseMultilineList } from '../../services/tenant-settings';
import type { TenantUserJwtPayload } from '../../lib/jwt';

/**
 * customer 子系统：租户信息 + 首页配置 —— 前台首页工作台
 * 详见 docs/12-b-需求-ai对话能力.md §B7
 *
 * 路由前缀：/api/v1/customer　鉴权：customer 角色（jwtAuth + requireCustomer）
 *
 * 端点：
 *   GET /profile   租户名 + 首页欢迎语 + 首页推荐问题
 *
 * ## 为什么前台拿租户信息要走这个端点
 * `GET /api/v1/public/widget/:tenantCode/info` 那条是给**匿名挂件**用的，
 * 它靠 URL 里的 tenantCode 定位租户；前台用户是登录进来的，租户在 JWT 里，
 * 不能靠前端传租户标识（能被改）。所以这里从 JWT 取 tenant_id 反查租户。
 *
 * ## 为什么不复用 `active-config`
 * 那个端点是给页脚显示「当前用的哪个模型」用的，是平台级信息，跟租户品牌无关。
 *
 * ## 跨租户隔离
 * 租户 id 只从 JWT 里读（`ctx.state.customerUser.tenant_id`），前端传什么都不作数。
 */

export const customerProfileRouter = new Router({ prefix: '/api/v1/customer' });

customerProfileRouter.use(jwtAuth, requireCustomer);

/** 取当前 customer —— 中间件已经保证一定存在且是 customer 角色 */
function currentUser(ctx: Context): TenantUserJwtPayload {
  return ctx.state.customerUser as TenantUserJwtPayload;
}

customerProfileRouter.get('/profile', async (ctx) => {
  const u = currentUser(ctx);

  const [tenant, settings] = await Promise.all([
    Tenant.findByPk(u.tenant_id, { attributes: ['id', 'code', 'name'] }),
    getSettingValues(u.tenant_id, ['home_welcome_message', 'home_suggested_questions']),
  ]);

  const welcomeRaw = settings['home_welcome_message'];
  const welcomeMessage = typeof welcomeRaw === 'string' ? welcomeRaw.trim() : '';

  ctx.body = {
    tenant: {
      code: tenant?.code ?? '',
      name: tenant?.name ?? '',
    },
    home: {
      // 留空时前端按租户名兜底出一句默认欢迎语（不要让首页是一片空白）
      welcome_message: welcomeMessage,
      suggested_questions: parseMultilineList(
        typeof settings['home_suggested_questions'] === 'string'
          ? settings['home_suggested_questions']
          : null,
      ),
    },
  };
});
