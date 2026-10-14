import { User } from '../models';

/**
 * 长期记忆 —— 详见 docs/16-b §B4 + docs/15 §Step 7
 *
 * 存 users.preferences JSON 列（schema 已有）：
 *  - language    语言偏好
 *  - timezone    时区
 *  - style       回答风格（'concise' / 'detailed'，Step 9 落地）
 *  - 其他键透传保留 forward-compat
 *
 * MVP 只读 + 解析；写回暂不实现（Step 9 配置页 + UI 反馈后做）
 */

export type UserPreferenceStyle = 'concise' | 'detailed' | 'default';

export interface ResolvedUserPreferences {
  language: string; // 默认 'zh-CN'
  timezone: string; // 默认 'Asia/Shanghai'
  style: UserPreferenceStyle;
  raw: Record<string, unknown>;
}

/**
 * 解析 user.preferences JSON，给上层提供类型安全的偏好
 * 找不到用户返回对象 → 返回默认值
 */
export async function getUserPreferences(
  userId: string | null,
): Promise<ResolvedUserPreferences> {
  const defaults: ResolvedUserPreferences = {
    language: 'zh-CN',
    timezone: 'Asia/Shanghai',
    style: 'default',
    raw: {},
  };
  if (userId === null) return defaults;
  const user = await User.findByPk(userId);
  if (user === null || user.preferences === null) return defaults;
  const raw = user.preferences;
  return {
    language: typeof raw['language'] === 'string' ? (raw['language'] as string) : defaults.language,
    timezone: typeof raw['timezone'] === 'string' ? (raw['timezone'] as string) : defaults.timezone,
    style:
      raw['style'] === 'concise' || raw['style'] === 'detailed' || raw['style'] === 'default'
        ? (raw['style'] as UserPreferenceStyle)
        : defaults.style,
    raw,
  };
}
