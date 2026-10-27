import axios, { type AxiosInstance } from 'axios';
import { attachTokenInterceptor, onUnauthorized } from './apiShared';
import { isWrongOldPasswordError } from './apiError';

const TOKEN_KEY = 'agent_platform_token';

/**
 * 取 token —— 「记住我」的两种存法都看。
 *
 *  - localStorage   → 记住我（跨浏览器重启保留，到 JWT 过期为止，默认 7 天）
 *  - sessionStorage → 没记住（关掉标签页/浏览器就没了）
 */
export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY) ?? sessionStorage.getItem(TOKEN_KEY);
}

/**
 * 存 token。
 *
 * @param remember 「记住我」勾没勾（docs/04-b §3.2）。
 *   - true  → localStorage，跨浏览器重启保留
 *   - false → sessionStorage，关掉浏览器就没了
 *   - null  → 登出 / token 过期：两个存储都清掉
 */
export function setToken(token: string | null, remember = true): void {
  localStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
  if (token === null) {
    return;
  }
  if (remember) {
    localStorage.setItem(TOKEN_KEY, token);
  } else {
    sessionStorage.setItem(TOKEN_KEY, token);
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
 * 按 baseURL 找登录页 —— 组件里要自己跳登录时用
 * （改密页 token 过期时需要带上提示，不能只 `location.replace`）。
 */
export function loginPathForBaseUrl(baseURL: string | undefined): string | null {
  if (baseURL === undefined) return null;
  return LOGIN_PATH_BY_BASE_URL[baseURL] ?? null;
}

/**
 * 「登录已过期」的跳转参数 —— 登录页读到它就显示「登录已过期，请重新登录」。
 *
 * ⚠️ 走 **URL query** 而不是 router state：token 过期时用的是
 *    `window.location.replace`（整页刷新），router state 会丢。
 */
export const EXPIRED_REASON_PARAM = 'reason';
export const EXPIRED_REASON_VALUE = 'expired';

/** 拼一个「登录已过期」的登录页地址 */
export function expiredLoginUrl(loginPath: string): string {
  return `${loginPath}?${EXPIRED_REASON_PARAM}=${EXPIRED_REASON_VALUE}`;
}

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
      if (loginPath === null) return;
      // 已经在登录页上就别跳了（登录接口本身失败也返 401）
      if (window.location.pathname.startsWith(loginPath)) return;
      // ⚠️ **改密页交给页面自己跳** —— 它要显示「登录已过期，请重新登录」，
      //    而且用 router 跳（不用整页刷新，提示才留得住）。这里只清 token。
      if (window.location.pathname.endsWith('/change-password')) return;
      // JWT 过期 → 自动跳本子系统的登录页（docs/04-d §11.3「JWT 过期自动跳登录」）。
      // 用 `replace` 而不是 `push`：登录完不该再按「后退」回到受保护的页面。
      window.location.replace(expiredLoginUrl(loginPath));
    },
    {
      // ⚠️ 「改密码时旧密码不对」也是 401，但它不代表 token 过期 ——
      //    清 token + 跳登录会把正在改密的用户白踢一次。
      //    ⚠️ **只能豁免「原密码不正确」这一种**（按响应体 message 判）——
      //    以前这里是 `url.endsWith('/change-password')`，把该端点的**所有** 401
      //    都豁免了：token 过期时 → 不清 token、不跳登录、界面一直显示
      //    「原密码不正确」→ 用户永远改不了密码。
      skip: (url, err) => url.endsWith('/change-password') && isWrongOldPasswordError(err),
    },
  );
  return instance;
}
