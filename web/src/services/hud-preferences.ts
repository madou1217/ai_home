// HUD 显示偏好：CRT 扫描线与 Web Audio 音效开关。
// 唯一真相存在 localStorage（键 aih.hud），本模块负责读写与订阅通知；
// UI（HUD 顶栏、设置页）只通过这里改动，保证两处开关状态一致。

export interface HudPreferences {
  crt: boolean;
  sfx: boolean;
}

export const HUD_PREFERENCES_KEY = 'aih.hud';
export const DEFAULT_HUD_PREFERENCES: HudPreferences = { crt: true, sfx: true };

type Listener = (prefs: HudPreferences) => void;

export interface HudPreferencesStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): HudPreferencesStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function parseHudPreferences(raw: string | null | undefined): HudPreferences {
  if (!raw) return { ...DEFAULT_HUD_PREFERENCES };
  try {
    const value = JSON.parse(raw) as Partial<HudPreferences>;
    return {
      crt: typeof value.crt === 'boolean' ? value.crt : DEFAULT_HUD_PREFERENCES.crt,
      sfx: typeof value.sfx === 'boolean' ? value.sfx : DEFAULT_HUD_PREFERENCES.sfx,
    };
  } catch {
    return { ...DEFAULT_HUD_PREFERENCES };
  }
}

export function createHudPreferencesStore(storage: HudPreferencesStorage | null = defaultStorage()) {
  let current = parseHudPreferences((() => {
    try {
      return storage?.getItem(HUD_PREFERENCES_KEY) ?? null;
    } catch {
      return null;
    }
  })());
  const listeners = new Set<Listener>();

  return {
    get(): HudPreferences {
      return current;
    },
    set(patch: Partial<HudPreferences>): HudPreferences {
      current = { ...current, ...patch };
      try {
        storage?.setItem(HUD_PREFERENCES_KEY, JSON.stringify(current));
      } catch {
        // 存储不可用时只影响刷新后的记忆
      }
      listeners.forEach((listener) => listener(current));
      return current;
    },
    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const hudPreferences = createHudPreferencesStore();
