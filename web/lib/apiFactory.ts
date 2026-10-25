import axios, { type AxiosInstance } from 'axios';
import { attachTokenInterceptor, onUnauthorized } from './apiShared';

const TOKEN_KEY = 'agent_platform_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token === null) {
    localStorage.removeItem(TOKEN_KEY);
  } else {
    localStorage.setItem(TOKEN_KEY, token);
  }
}

/**
 * 各子系统的登录页 —— 401（token 过期）时往哪跳。
 *
 * ⚠️ **每个子系统跳自己的登录页**：admin 的 token 过期却把人送到
 *    customer 的登录页，体验上很怪（虽然安全上没错）。
 */
const LOGIN_PATH_BY_BASE_URL: Record<string, string> = {
  '/api/v1/admin': '/admin/login',
  '/api/v1/customer': '/customer/login',
  '/api/v1/system': '/system/login',
};

/**
 * 前端 axios 实例：自动带 Authorization 头（token 来自 localStorage）
 * 详见 docs/03-c-技术栈-前端栈.md §C.1
 *
 * 各子系统用各自独立的实例（baseURL 不同），避免子系统之间互相影响
 */
export function createApi(baseURL: string): AxiosInstance {
  const instance = axios.create({ baseURL, timeout: 10_000 });
  attachTokenInterceptor(instance, getToken);

  const loginPath = LOGIN_PATH_BY_BASE_URL[baseURL] ?? null;
  onUnauthorized(
    instance,
    () => {
      setToken(null);
      // JWT 过期 → 自动跳本子系统的登录页（docs/04-d §11.3「JWT 过期自动跳登录」）。
      // 用 `replace` 而不是 `push`：登录完不该再按「后退」回到受保护的页面。
      // 已经在登录页上就别跳了（登录接口本身失败也返 401）。
      if (loginPath !== null && !window.location.pathname.startsWith(loginPath)) {
        window.location.replace(loginPath);
      }
    },
    {
      // ⚠️ 「改密码时旧密码不对」也是 401，但它不代表 token 过期 ——
      //    清 token + 跳登录会把正在改密的用户白踢一次。
      skip: (url) => url.endsWith('/change-password'),
    },
  );
  return instance;
}
