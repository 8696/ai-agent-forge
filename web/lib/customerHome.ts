import { customerApi } from './customerApi';

/**
 * 前台 · 首页工作台 API —— B7（docs/12-b-需求-ai对话能力.md §B7）
 *
 * 对应后端：
 *   src/gateway/customer/profile-routes.ts    GET /profile
 *   src/gateway/customer/knowledge-routes.ts  GET /documents
 */

/** 租户信息 + 首页配置 */
export interface CustomerProfile {
  tenant: {
    code: string;
    name: string;
  };
  home: {
    /** 租户配的欢迎语；空串 = 前端按租户名兜底 */
    welcome_message: string;
    /** 租户配的推荐问题；空数组 = 首页不显示这一块 */
    suggested_questions: string[];
  };
}

/** 知识库里的一份资料（只读元信息，没有正文） */
export interface CustomerDocumentItem {
  id: string;
  title: string;
  file_type: string | null;
  status: 'uploaded' | 'indexing' | 'ready' | 'failed';
  chunk_count: number;
  updated_at: string;
}

export async function fetchProfile(): Promise<CustomerProfile> {
  const { data } = await customerApi.get<CustomerProfile>('/profile');
  return data;
}

export async function fetchCustomerDocuments(limit = 10): Promise<{
  documents: CustomerDocumentItem[];
  total: number;
}> {
  const { data } = await customerApi.get<{
    documents: CustomerDocumentItem[];
    total: number;
  }>('/documents', { params: { limit } });
  return data;
}
