import { Op } from 'sequelize';
import { getSequelize } from '../db';
import { TenantSetting } from '../models';
import { ValidationError } from '../lib/errors';
import { logger } from '../logger';

/**
 * 租户通用配置（KV）—— docs/12-c §C4 / docs/12-e §E2
 *
 * **元信息在代码里，值在库里**：
 *  - `SETTINGS_REGISTRY` 声明每个配置项的类型 / 名称 / 分类 / 默认值 / 取值范围
 *  - `tenant_settings` 表只存「租户改过的那些」——没改过的键根本不占行
 *
 * 这么切的理由：
 *  - 类型和范围校验必须有代码（手写解析），否则 KV 表会退化成人人可写的万能垃圾桶
 *  - 后台页面按 registry 渲染，加一个配置项不用碰 SQL
 *  - 值解析失败时**当作没配**回落默认 + 记 warn —— 不能因为一个手滑存进去的坏值
 *    就让整个对话挂掉
 *
 * 每轮对话读一次（docs/12-e §E2「改完不重启立即生效」）。
 */

export type SettingValueType = 'number' | 'boolean' | 'string';

export interface SettingSpec {
  key: string;
  label: string;
  /** 后台分组（页面上按它分区） */
  category: string;
  description: string;
  type: SettingValueType;
  /** 类型 number 时的取值范围 */
  min?: number;
  max?: number;
  /** 进程级默认值（配置表与 .env 的 CHAT_* 对齐） */
  fallback: number | boolean | string;
}

/**
 * 已知配置项注册表
 *
 * ⚠️ 只收「安全边界」和「平台成本边界」之外的项：
 * 加密密钥、SSRF 开关、上下文总预算、SSE 心跳这些留在 .env（理由见 docs/12-c §C4）。
 * 加新项时先问一句「这是平台该管的，还是租户该调的」。
 */
export const SETTINGS_REGISTRY: SettingSpec[] = [
  {
    key: 'retrieval_top_k',
    label: '检索召回条数',
    category: '知识库',
    description: '每轮从知识库捞几个候选块。语料少时调到 8~10 往往立竿见影',
    type: 'number',
    min: 1,
    max: 50,
    fallback: 5,
  },
  {
    key: 'max_history_turns',
    label: '最多记多少轮历史',
    category: '知识库',
    description: 'AI 能记住多少轮对话。觉得它忘事就调大',
    type: 'number',
    min: 0,
    max: 100,
    fallback: 10,
  },
  {
    key: 'retrieval_token_budget',
    label: '检索片段 token 上限',
    category: '知识库',
    description:
      '知识库片段最多能占多少 token。调小 = 只喂最相关的几条；调大 = 召回更全但更贵',
    type: 'number',
    min: 100,
    max: 20000,
    fallback: 2500,
  },
  {
    key: 'context_token_budget',
    label: '单轮上下文总预算',
    category: '成本',
    description:
      'system + 历史 + 检索片段三块之和的上限。超了就丢最旧的内容（会提示用户「已省略更早的 N 轮」）。**这是单次请求的成本闸门**，调大 = 更贵也更慢',
    type: 'number',
    min: 1000,
    max: 200000,
    fallback: 8000,
  },
  {
    key: 'max_input_chars',
    label: '单条消息字数上限',
    category: '成本',
    description: '用户单次提问的字数上限，超了直接拒。防超长输入挤爆上下文',
    type: 'number',
    min: 1,
    max: 50000,
    fallback: 2000,
  },
  {
    key: 'thinking_budget_tokens',
    label: '思考模式预算',
    category: '模型',
    description:
      '推理 token 预算，**0 = 关闭**。多数 provider 自己的模型不传参数也会吐推理过程，这个开关只是「强制开启并限制预算」',
    type: 'number',
    min: 0,
    max: 32000,
    fallback: 0,
  },
  {
    key: 'monthly_token_budget',
    label: '月度 token 预算',
    category: '成本',
    description:
      '本租户每月可用的 token 上限，**0 = 不限**。超了会写告警（后台顶栏 + 审计日志）；' +
      '是否直接拒绝新请求由服务端 .env 的 COST_BUDGET_BLOCK 决定',
    type: 'number',
    min: 0,
    max: 1_000_000_000,
    fallback: 0,
  },
  {
    key: 'rate_limit_per_minute',
    label: '每分钟请求上限',
    category: '安全',
    description:
      '本租户每分钟最多能发多少轮对话，**0 = 用平台默认**（.env 的 RATE_LIMIT_MAX_REQUESTS）。' +
      '超了返回 429',
    type: 'number',
    min: 0,
    max: 100000,
    fallback: 0,
  },
];

const REGISTRY_BY_KEY = new Map(SETTINGS_REGISTRY.map((s) => [s.key, s]));

export function settingSpec(key: string): SettingSpec | undefined {
  return REGISTRY_BY_KEY.get(key);
}

/** 校验并规范化一个值；不合法直接抛 400（错误信息给 admin 看） */
export function coerceSettingValue(spec: SettingSpec, raw: unknown): string {
  if (spec.type === 'number') {
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n)) {
      throw new ValidationError(`${spec.label}：必须是数字`);
    }
    if (spec.min !== undefined && n < spec.min) {
      throw new ValidationError(`${spec.label}：不能小于 ${spec.min}`);
    }
    if (spec.max !== undefined && n > spec.max) {
      throw new ValidationError(`${spec.label}：不能大于 ${spec.max}`);
    }
    return String(n);
  }
  if (spec.type === 'boolean') {
    if (typeof raw !== 'boolean') {
      throw new ValidationError(`${spec.label}：必须是布尔值`);
    }
    return raw ? 'true' : 'false';
  }
  return String(raw);
}

/** 库里的字符串 → 真正的值；解析不出来就回落到 spec.fallback */
export function parseSettingValue(spec: SettingSpec, raw: string | null | undefined): number | boolean | string {
  if (raw === null || raw === undefined || raw === '') {
    return spec.fallback;
  }
  if (spec.type === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      logger.warn({ key: spec.key, raw }, '配置值解析失败，按默认值走');
      return spec.fallback;
    }
    return n;
  }
  if (spec.type === 'boolean') {
    return raw === 'true';
  }
  return raw;
}

export interface SettingView {
  key: string;
  label: string;
  category: string;
  description: string;
  type: SettingValueType;
  min?: number;
  max?: number;
  /** 生效中的值（租户覆盖 or 进程默认） */
  value: number | boolean | string;
  /** 平台默认值，页面上用来提示 */
  fallback: number | boolean | string;
  /** 是否被租户显式覆盖过 */
  overridden: boolean;
  updated_at: string | null;
}

/** 读本租户全部配置（registry 里没被覆盖的项也返回，value = 默认值） */
export async function listSettings(tenantId: string): Promise<SettingView[]> {
  const rows = await TenantSetting.findAll({ where: { tenant_id: tenantId } });
  const byKey = new Map(rows.map((r) => [r.config_key, r]));

  return SETTINGS_REGISTRY.map((spec) => {
    const row = byKey.get(spec.key);
    return {
      key: spec.key,
      label: spec.label,
      category: spec.category,
      description: spec.description,
      type: spec.type,
      ...(spec.min === undefined ? {} : { min: spec.min }),
      ...(spec.max === undefined ? {} : { max: spec.max }),
      value: parseSettingValue(spec, row?.config_value),
      fallback: spec.fallback,
      overridden: row !== undefined,
      updated_at: row?.updated_at.toISOString() ?? null,
    };
  });
}

/**
 * 取单个配置项的生效值（对话链路用）。
 * 读不到 / 键不在 registry 里 → 返回 null，调用方走 .env 默认。
 */
export async function getSettingValue(
  tenantId: string,
  key: string,
): Promise<number | boolean | string | null> {
  const spec = settingSpec(key);
  if (spec === undefined) {
    return null;
  }
  try {
    const row = await TenantSetting.findOne({ where: { tenant_id: tenantId, config_key: key } });
    return parseSettingValue(spec, row?.config_value);
  } catch (err: unknown) {
    logger.warn({ tenantId, key, err: err instanceof Error ? err.message : String(err) }, '读租户配置失败，用平台默认');
    return null;
  }
}

/** 一次读多个键（对话每轮都要，省 N 次往返） */
export async function getSettingValues(
  tenantId: string,
  keys: readonly string[],
): Promise<Record<string, number | boolean | string | null>> {
  const specs = keys
    .map((k) => settingSpec(k))
    .filter((s): s is SettingSpec => s !== undefined);
  if (specs.length === 0) {
    return {};
  }
  const out: Record<string, number | boolean | string | null> = {};
  for (const spec of specs) {
    out[spec.key] = spec.fallback;
  }
  try {
    const rows = await TenantSetting.findAll({
      where: { tenant_id: tenantId, config_key: { [Op.in]: keys } },
    });
    for (const row of rows) {
      const spec = settingSpec(row.config_key);
      if (spec !== undefined) {
        out[spec.key] = parseSettingValue(spec, row.config_value);
      }
    }
  } catch (err: unknown) {
    logger.warn({ tenantId, err: err instanceof Error ? err.message : String(err) }, '批量读租户配置失败，用平台默认');
  }
  return out;
}

/**
 * 批量保存。语义与 `/config/llm` 一致：
 *   - 不在 registry 里的 key → 400（防止前端拼错 key 静默写进去）
 *   - null → 删掉这一行（清除覆盖，回落默认）
 */
export async function saveSettings(
  tenantId: string,
  userId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const sequelize = getSequelize();
  await sequelize.transaction(async (t) => {
    for (const [key, raw] of Object.entries(payload)) {
      const spec = settingSpec(key);
      if (spec === undefined) {
        throw new ValidationError(`未知的配置项：${key}`);
      }
      if (raw === null) {
        await TenantSetting.destroy({ where: { tenant_id: tenantId, config_key: key }, transaction: t });
        continue;
      }
      const value = coerceSettingValue(spec, raw);
      const existing = await TenantSetting.findOne({
        where: { tenant_id: tenantId, config_key: key },
        transaction: t,
      });
      if (existing === null) {
        await TenantSetting.create(
          { tenant_id: tenantId, config_key: key, config_value: value, updated_by: userId },
          { transaction: t },
        );
      } else {
        existing.config_value = value;
        existing.updated_by = userId;
        await existing.save({ transaction: t });
      }
    }
  });
}
