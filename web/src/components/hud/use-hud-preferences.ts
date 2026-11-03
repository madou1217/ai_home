import { useSyncExternalStore } from 'react';
import { hudPreferences, type HudPreferences } from '@/services/hud-preferences';

const subscribe = (listener: () => void) => hudPreferences.subscribe(listener);
const getSnapshot = () => hudPreferences.get();

/** 订阅 HUD 显示偏好（CRT / 音效），任一处修改后所有开关同步刷新。 */
export function useHudPreferences(): [HudPreferences, (patch: Partial<HudPreferences>) => void] {
  const prefs = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return [prefs, hudPreferences.set];
}
