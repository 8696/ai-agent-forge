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
 * 前端 axios 实例：自动带 Authorization 头（token 来自 localStorage）
 * 详见 docs/03-技术栈与规范.md §C.1
 *
 * 各子系统用各自独立的实例（baseURL 不同），避免子系统之间互相影响
 */
export function createApi(baseURL: string): AxiosInstance {
  const instance = axios.create({ baseURL, timeout: 10_000 });
  attachTokenInterceptor(instance, getToken);
  onUnauthorized(instance, () => setToken(null));
  return instance;
}
