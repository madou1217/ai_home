import { useSyncExternalStore } from 'react';
import {
  readThemeMode,
  subscribeThemeMode,
  type ThemeMode,
} from '@/services/theme-mode';

const getSnapshot = () => readThemeMode();
// 服务端/预渲染没有 document，按 design-tokens.css 的裸 :root 取浅色。
const getServerSnapshot = (): ThemeMode => 'light';

/** 跟随 documentElement 的 data-theme，供需要在 JS 侧感知主题的组件使用。 */
export function useThemeMode(): ThemeMode {
  return useSyncExternalStore(subscribeThemeMode, getSnapshot, getServerSnapshot);
}
