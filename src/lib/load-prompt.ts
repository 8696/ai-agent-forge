import { Tenant } from '../models';
import { SYSTEM_PROMPT as V1 } from '@shared/prompts/customer-service/system.v1';
import { logger } from '../logger';

/**
 * 加载租户当前生效的系统提示词 —— 详见 docs/16-c §C3 + docs/15 §Step 6/9
 *
 * Step 6 MVP 行为：
 *  - 永远加载 v1（shared/prompts/customer-service/system.v1.ts）
 *  - 读 tenant.settings.prompt_version 字段（Step 9 才会真正接 prompt_versions 表 + UI 切换）
 *  - 找不到租户 / tenant.name 为空时回落到通用「客服」占位
 *
 * Step 9 落地后会改成：
 *  - 读 tenants.settings.prompt_version → 动态 import 对应 v{N}.ts
 *  - 增加一层「未发布即回退到上一个已发布版本」的策略
 */
export async function loadSystemPrompt(tenantId: string): Promise<string> {
  const tenant = await Tenant.findByPk(tenantId);
  const tenantName = tenant?.name?.trim() ?? '';
  const version = tenant?.settings?.prompt_version ?? 'v1';

  // MVP：只支持 v1；非 v1 一律回退 v1 + warn（不让请求挂）
  if (version !== 'v1') {
    logger.warn(
      { tenantId, requestedVersion: version, fallback: 'v1' },
      'loadSystemPrompt · prompt_version 非 v1，本期回退到 v1',
    );
  }

  return V1.replace('{tenantName}', tenantName === '' ? '客服' : tenantName);
}
