import { useEffect, useState } from 'react';

/**
 * 深色模式开关 —— docs/04-d-ui-系统级与公共组件.md §9.3
 *
 * 规则：
 *   - 右上角 ☀ / 🌙 按钮切换
 *   - 选择持久化到 localStorage（`agentforge:theme-mode`）
 *   - **没存过**时跟随系统 `prefers-color-scheme`
 *   - 用户手动切过之后，以用户的选择为准（不再跟着系统变）
 *
 * 用一个模块级 store 而不是 React context：
 * 根组件（App.tsx 的 ConfigProvider）和顶栏按钮在**两棵不同的树**里
 * （ConfigProvider 包着 Router，切换按钮在 Layout 里），
 * context 要多套一层 provider，store 更简单。
 */

export type ThemeMode = 'light' | 'dark';

const STORAGE_KEY = 'agentforge:theme-mode';

type Listener = () => void;

const listeners = new Set<Listener>();

function readStored(): ThemeMode | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === 'dark' || v === 'light' ? v : null;
  } catch {
    // 隐私模式 / 存储被禁用 —— 当没存过
    return null;
  }
}

function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** 当前模式（模块级状态，读起来是同步的） */
let mode: ThemeMode = readStored() ?? (systemPrefersDark() ? 'dark' : 'light');

export function getThemeMode(): ThemeMode {
  return mode;
}

export function setThemeMode(next: ThemeMode): void {
  if (next === mode) return;
  mode = next;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // 存不了就只在本次会话生效，不报错
    }
  }
  listeners.forEach((l) => l());
}

export function toggleThemeMode(): void {
  setThemeMode(mode === 'dark' ? 'light' : 'dark');
}

/** React 订阅 —— 组件里用它拿到当前模式 */
export function useThemeMode(): ThemeMode {
  const [current, setCurrent] = useState<ThemeMode>(mode);
  useEffect(() => {
    const listener = (): void => setCurrent(mode);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return current;
}
