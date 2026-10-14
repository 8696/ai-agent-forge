import { createApi } from './apiFactory';

/**
 * system 子系统专属 axios 实例：baseURL 指向 /api/v1/system
 * 详见 docs/03-技术栈与规范.md §B.5
 */
export const systemApi = createApi('/api/v1/system');
