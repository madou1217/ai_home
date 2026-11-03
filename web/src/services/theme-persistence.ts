// 主题的唯一写入入口：写 document.documentElement 的 data-theme 并持久化。
// 读取与订阅仍走 theme-mode.ts；首帧前的初始写入由 config.ts 的 headScripts 完成，
// 两处使用同一个存储键，保证刷新后主题一致（默认深色 HUD）。

import { THEME_ATTRIBUTE, type ThemeMode } from '@/services/theme-mode';

export const THEME_STORAGE_KEY = 'aih.theme';
export const DEFAULT_THEME_MODE: ThemeMode = 'dark';

/** 宿主能力最小集合，便于在测试中注入替身。 */
export interface ThemePersistenceHost {
  root?: { setAttribute(name: string, value: string): void } | null;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
}

function resolveHost(host?: ThemePersistenceHost): Required<ThemePersistenceHost> {
  const root = host?.root !== undefined
    ? host.root
    : (typeof document === 'undefined' ? null : document.documentElement);
  let storage: Pick<Storage, 'getItem' | 'setItem'> | null = null;
  if (host?.storage !== undefined) {
    storage = host.storage;
  } else {
    try {
      storage = typeof window === 'undefined' ? null : window.localStorage;
    } catch {
      storage = null;
    }
  }
  return { root, storage };
}

export function readStoredThemeMode(host?: ThemePersistenceHost): ThemeMode {
  const { storage } = resolveHost(host);
  try {
    const value = storage?.getItem(THEME_STORAGE_KEY);
    if (value === 'light' || value === 'dark') return value;
  } catch {
    // 隐私模式等存储不可用时回落默认主题
  }
  return DEFAULT_THEME_MODE;
}

/** 应用主题并持久化。persist=false 用于跨标签页同步的被动应用（由发起方负责持久化）。 */
export function applyThemeMode(
  mode: ThemeMode,
  options: { persist?: boolean } = {},
  host?: ThemePersistenceHost,
): void {
  const { root, storage } = resolveHost(host);
  root?.setAttribute(THEME_ATTRIBUTE, mode);
  if (options.persist === false) return;
  try {
    storage?.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // 存储不可用时只影响刷新后的记忆，不影响当前页面
  }
}
