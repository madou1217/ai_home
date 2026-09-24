import { message } from 'antd';
import { useCallback, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { useHudPreferences } from '@/components/hud/use-hud-preferences';
import { useThemeMode } from '@/hooks/use-theme-mode';
import { crossTabSync } from '@/services/cross-tab-session-sync';
import { DynamicWallpaperEngine } from '@/services/dynamic-wallpaper-engine';
import { applyThemeMode } from '@/services/theme-persistence';
import { validateWallpaperFile } from './settings-config';

/**
 * 外观个性化：动态壁纸（localStorage 持久化 + 启动恢复，见 app.tsx）、HUD 显示偏好（CRT / 音效，
 * 与 HUD 顶栏开关共用同一份状态）与主题。页面只需渲染一个隐藏的 file input 并绑定 ref / onChange。
 */
export function useAppearanceSettings() {
  const [hasCustomWallpaper, setHasCustomWallpaper] = useState(() => Boolean(DynamicWallpaperEngine.getSavedWallpaper()));
  const wallpaperFileInputRef = useRef<HTMLInputElement | null>(null);
  const [hudPrefs, setHudPrefs] = useHudPreferences();
  const themeMode = useThemeMode();

  const handleThemeModeChange = useCallback((dark: boolean) => {
    const next = dark ? 'dark' : 'light';
    applyThemeMode(next);
    crossTabSync.broadcast('THEME_CHANGED', { theme: next });
  }, []);

  const openWallpaperPicker = useCallback(() => {
    wallpaperFileInputRef.current?.click();
  }, []);

  const handleWallpaperFileChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const problem = validateWallpaperFile(file);
    if (problem) {
      message.warning(problem);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      if (!dataUrl) return;
      DynamicWallpaperEngine.saveWallpaper(dataUrl);
      setHasCustomWallpaper(true);
      message.success('动态壁纸已应用');
    };
    reader.readAsDataURL(file);
  }, []);

  const handleWallpaperClear = useCallback(() => {
    DynamicWallpaperEngine.clearWallpaper();
    setHasCustomWallpaper(false);
    message.success('已恢复默认背景');
  }, []);

  return {
    hasCustomWallpaper,
    wallpaperFileInputRef,
    openWallpaperPicker,
    handleWallpaperFileChange,
    handleWallpaperClear,
    hudPrefs,
    setHudPrefs,
    themeMode,
    handleThemeModeChange
  };
}
