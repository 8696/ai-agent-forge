import type { InternalAxiosRequestConfig, AxiosInstance } from 'axios';

/**
 * 公共 axios 拦截器（3 个子系统的 api 实例共享）
 * 详见 docs/03-技术栈与规范.md §C.1
 *
 * 注意：拦截器是纯函数，不绑死 baseURL；3 个子系统各自的 api 实例
 * 在 apiFactory.ts 里 attach
 */

export function attachTokenInterceptor(
  instance: AxiosInstance,
  getToken: () => string | null,
): void {
  instance.interceptors.request.use((config: InternalAxiosRequestConfig) => {
    const token = getToken();
    if (token !== null && config.headers !== undefined) {
      config.headers.set('Authorization', `Bearer ${token}`);
    }
    return config;
  });
}

export function onUnauthorized(instance: AxiosInstance, clearToken: () => void): void {
  instance.interceptors.response.use(
    (res) => res,
    (err: unknown) => {
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status === 401) {
        clearToken();
      }
      return Promise.reject(err);
    },
  );
}
