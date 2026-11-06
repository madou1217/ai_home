import { useCallback } from 'react';
import { useHudPreferences } from '@/components/hud/use-hud-preferences';
import { useThemeMode } from '@/hooks/use-theme-mode';
import { crossTabSync } from '@/services/cross-tab-session-sync';
import { applyThemeModeAnimated } from '@/services/theme-transition';

/**
 * 外观个性化：HUD 显示偏好（CRT / 音效，与 HUD 顶栏开关共用同一份状态）与主题。
 */
export function useAppearanceSettings() {
  const [hudPrefs, setHudPrefs] = useHudPreferences();
  const themeMode = useThemeMode();

  const handleThemeModeChange = useCallback((dark: boolean) => {
    const next = dark ? 'dark' : 'light';
    applyThemeModeAnimated(next);
    crossTabSync.broadcast('THEME_CHANGED', { theme: next });
  }, []);

  return {
    hudPrefs,
    setHudPrefs,
    themeMode,
    handleThemeModeChange
  };
}
