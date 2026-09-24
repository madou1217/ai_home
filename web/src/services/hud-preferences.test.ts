import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_HUD_PREFERENCES,
  HUD_PREFERENCES_KEY,
  createHudPreferencesStore,
  parseHudPreferences,
} from './hud-preferences';
import { THEME_STORAGE_KEY, applyThemeMode, readStoredThemeMode } from './theme-persistence';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => (data.has(key) ? data.get(key)! : null),
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

test('HUD 偏好默认开启 CRT 与音效，损坏或缺字段时回落默认值', () => {
  assert.deepEqual(parseHudPreferences(null), DEFAULT_HUD_PREFERENCES);
  assert.deepEqual(parseHudPreferences('not json'), DEFAULT_HUD_PREFERENCES);
  assert.deepEqual(parseHudPreferences('{"crt":false}'), { crt: false, sfx: true });
  assert.deepEqual(parseHudPreferences('{"crt":"no","sfx":false}'), { crt: true, sfx: false });
});

test('HUD 偏好写入后持久化并通知所有订阅方', () => {
  const storage = memoryStorage();
  const store = createHudPreferencesStore(storage);
  const seen: boolean[] = [];
  const unsubscribe = store.subscribe((prefs) => seen.push(prefs.sfx));

  store.set({ sfx: false });
  assert.equal(store.get().sfx, false);
  assert.equal(store.get().crt, true);
  assert.deepEqual(JSON.parse(storage.getItem(HUD_PREFERENCES_KEY)!), { crt: true, sfx: false });
  assert.deepEqual(seen, [false]);

  unsubscribe();
  store.set({ sfx: true });
  assert.deepEqual(seen, [false]);
});

test('HUD 偏好在存储不可用时仍可在内存中切换', () => {
  const store = createHudPreferencesStore(null);
  store.set({ crt: false });
  assert.equal(store.get().crt, false);
});

test('主题默认深色 HUD，只接受 light / dark 两个存储值', () => {
  assert.equal(readStoredThemeMode({ storage: memoryStorage() }), 'dark');
  assert.equal(readStoredThemeMode({ storage: memoryStorage({ [THEME_STORAGE_KEY]: 'light' }) }), 'light');
  assert.equal(readStoredThemeMode({ storage: memoryStorage({ [THEME_STORAGE_KEY]: 'blue' }) }), 'dark');
});

test('applyThemeMode 写 data-theme 并持久化；persist=false 只应用不写入', () => {
  const attrs: Record<string, string> = {};
  const root = { setAttribute: (name: string, value: string) => { attrs[name] = value; } };
  const storage = memoryStorage();

  applyThemeMode('light', {}, { root, storage });
  assert.equal(attrs['data-theme'], 'light');
  assert.equal(storage.getItem(THEME_STORAGE_KEY), 'light');

  applyThemeMode('dark', { persist: false }, { root, storage });
  assert.equal(attrs['data-theme'], 'dark');
  assert.equal(storage.getItem(THEME_STORAGE_KEY), 'light');
});
