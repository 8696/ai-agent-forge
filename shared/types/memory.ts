/**
 * 前后端共用的记忆类型 —— B4 长期记忆（docs/12-b-需求-ai对话能力.md §B4）
 *
 * 为什么要放 shared/：
 *  租户后台的「用户记忆」页和前台的「我的记忆」页渲染的是同一种东西，
 *  分类 / 来源 / 状态的文案和配色两边必须一致 —— 只能有一份定义。
 */

/** 记忆分类 */
export type MemoryCategory = 'profile' | 'preference' | 'fact' | 'context';

/** 记忆来源 —— 决定自动抽取能不能改它 */
export type MemorySource = 'auto' | 'user' | 'admin';

/** 记忆状态 */
export type MemoryStatus = 'active' | 'archived';

export const MEMORY_CATEGORIES: readonly MemoryCategory[] = [
  'profile',
  'preference',
  'fact',
  'context',
];

export const MEMORY_SOURCES: readonly MemorySource[] = ['auto', 'user', 'admin'];

/** 分类的中文标签（两边页面共用） */
export const MEMORY_CATEGORY_LABEL: Record<MemoryCategory, string> = {
  profile: '画像',
  preference: '偏好',
  fact: '事实',
  context: '情境',
};

/** 来源的中文标签 */
export const MEMORY_SOURCE_LABEL: Record<MemorySource, string> = {
  auto: '自动抽取',
  user: '用户自写',
  admin: '管理员',
};

/**
 * 一条记忆。
 *
 * tenant_id / user_id 一并带上前端 —— 租户后台要按用户分组，
 * 前台要显示「这条是我的」。
 */
export interface UserMemoryItem {
  id: string;
  tenant_id: string;
  user_id: string;
  category: MemoryCategory;
  content: string;
  source: MemorySource;
  /** 抽取置信度 0~1 */
  confidence: number;
  status: MemoryStatus;
  /** 被注入进提示词的次数 */
  hit_count: number;
  last_hit_at: string | null;
  source_session_id: string | null;
  source_message_id: string | null;
  created_at: string;
  updated_at: string;
}

/** 租户后台的列表项：多一个用户邮箱 */
export interface AdminMemoryItem extends UserMemoryItem {
  user_email: string;
}

/** 分页信封（与后台其它列表页形状一致） */
export interface MemoryPagination {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
}

/** 租户后台：哪些用户有记忆 */
export interface MemoryOwner {
  user_id: string;
  email: string;
  role: string;
  memory_count: number;
  last_hit_at: string | null;
}
