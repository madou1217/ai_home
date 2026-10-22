import { beforeEach, describe, expect, test } from 'bun:test';
import {
  getTranslationFloatingPreferences,
  resetTranslationFloatingPreferencesForTests,
  setTranslationFloatingPreferences,
  subscribeTranslationFloatingPreferences,
  toggleTranslationFloating,
} from './translation-preferences';

describe('translation floating preferences', () => {
  beforeEach(() => {
    resetTranslationFloatingPreferencesForTests();
  });

  test('defaults to enabled', () => {
    expect(getTranslationFloatingPreferences().enabled).toBe(true);
  });

  test('toggling flips and notifies subscribers', () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeTranslationFloatingPreferences((preferences) => {
      seen.push(preferences.enabled);
    });

    expect(toggleTranslationFloating().enabled).toBe(false);
    expect(toggleTranslationFloating().enabled).toBe(true);

    unsubscribe();
    setTranslationFloatingPreferences({ enabled: false });

    expect(seen).toEqual([false, true]);
    expect(getTranslationFloatingPreferences().enabled).toBe(false);
  });

  test('invalid stored values do not permanently disable the feature', () => {
    // 只认显式 false：坏值（undefined / null / 字符串）一律回到开启。
    expect(setTranslationFloatingPreferences({ enabled: undefined as unknown as boolean }).enabled).toBe(true);
    expect(getTranslationFloatingPreferences().enabled).toBe(true);
  });
});
