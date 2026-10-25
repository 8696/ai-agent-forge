import type { InternalAxiosRequestConfig, AxiosInstance } from 'axios';

/**
 * 公共 axios 拦截器（3 个子系统的 api 实例共享）
 * 详见 docs/03-c-技术栈-前端栈.md §C.1
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

/**
 * 401 处理：清掉本地 token（+ 由调用方决定要不要跳登录页）。
 *
 * ⚠️ **有些 401 不是「token 过期」** —— 比如改密码时旧密码不对，
 *    那是 401 但 token 好得很。清掉 token 会把正在改密的用户白踢回登录页，
 *    让他把邮箱密码重打一遍（而他本来就快改完了）。
 *    所以给 `opts.skip` 一个口子，让调用方把这类端点排除掉。
 */
export function onUnauthorized(
  instance: AxiosInstance,
  clearToken: () => void,
  opts?: { skip?: (url: string) => boolean },
): void {
  instance.interceptors.response.use(
    (res) => res,
    (err: unknown) => {
      const status = (err as { response?: { status?: number } }).response?.status;
      const url = (err as { config?: { url?: string } }).config?.url ?? '';
      if (status === 401 && !(opts?.skip?.(url) ?? false)) {
        clearToken();
      }
      return Promise.reject(err);
    },
  );
}
