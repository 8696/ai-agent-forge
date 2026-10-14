import Router from '@koa/router';
import { config, resolveEmbedding, resolveLlm } from '../config';

/**
 * 公共「当前激活配置」端点 —— 供前端页脚展示当前 LLM / Embedding 模型。
 * 详见 docs/06-API接口.md §6.4。
 *
 * 设计要点：
 *  - 无需鉴权：3 个子系统页脚都要用，登录页也可能要展示
 *  - 永远可用（不像 devProbeRouter 在生产 404）：运营方需要随时看到当前生效的模型
 *  - resolveLlm 失败 → 503（app 启动后此调用不会失败，兜底返回错误）
 *  - resolveEmbedding 失败（譬如 LLM_PROVIDER=deepseek 没 Embedding）→ embedModel/embedDimensions 留空
 */
export const activeConfigRouter = new Router({ prefix: '/api/v1' });

interface ActiveConfigResponse {
  provider: string;
  llmModel: string;
  embedModel: string;
  embedDimensions: number;
}

activeConfigRouter.get('/active-config', (ctx) => {
  let provider = config.LLM_PROVIDER;
  let llmModel = config.LLM_MODEL;
  let embedModel = config.LLM_EMBEDDING_MODEL;

  try {
    const llmCfg = resolveLlm();
    provider = llmCfg.provider;
    llmModel = llmCfg.llmModel;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.status = 503;
    ctx.body = { error: 'llm_unavailable', message };
    return;
  }

  let embedDimensions = 0;
  try {
    const embedCfg = resolveEmbedding();
    embedModel = embedCfg.embedModel;
    embedDimensions = embedCfg.embedDimensions;
  } catch {
    // 当前 provider 不提供 Embedding（如 deepseek），前端展示「—」
    embedModel = '';
    embedDimensions = 0;
  }

  const body: ActiveConfigResponse = {
    provider,
    llmModel,
    embedModel,
    embedDimensions,
  };
  ctx.body = body;
});
