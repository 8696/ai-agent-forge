import { createApi } from './apiFactory';

/**
 * customer 子系统专属 axios 实例：baseURL 指向 /api/v1/customer
 * 详见 docs/03-技术栈与规范.md §B.5
 */
export const customerApi = createApi('/api/v1/customer');
