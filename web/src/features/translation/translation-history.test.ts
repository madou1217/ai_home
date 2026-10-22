import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  TRANSLATION_HISTORY_LIMIT,
  __resetTranslationHistoryCache,
  appendTranslationHistory,
  clearTranslationHistory,
  formatTranslationHistoryTime,
  loadTranslationHistory,
  removeTranslationHistoryEntry,
} from './translation-history';

function createMemoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => (map.has(key) ? map.get(key) as string : null),
    setItem: (key: string, value: string) => {
      map.set(key, String(value));
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  } as Storage;
}

const sample = {
  sourceText: 'Hello, world!',
  resultText: '你好，世界！',
  sourceLang: 'en',
  targetLang: 'zh-Hans',
  sourceLabel: '英语',
  targetLabel: '简体中文',
  model: 'claude-opus-4-6',
  provider: 'agy',
};

describe('translation history storage', () => {
  beforeEach(() => {
    (globalThis as unknown as { window: unknown }).window = { localStorage: createMemoryStorage() };
    __resetTranslationHistoryCache();
  });

  afterEach(() => {
    __resetTranslationHistoryCache();
  });

  test('returns empty list when nothing is stored', () => {
    expect(loadTranslationHistory()).toEqual([]);
  });

  test('persists an entry and reloads it', () => {
    appendTranslationHistory(sample);
    __resetTranslationHistoryCache();
    const entries = loadTranslationHistory();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      sourceText: sample.sourceText,
      resultText: sample.resultText,
      model: sample.model,
      provider: sample.provider,
      sourceLabel: sample.sourceLabel,
      targetLabel: sample.targetLabel,
    });
    expect(typeof entries[0].id).toBe('string');
    expect(entries[0].id.length).toBeGreaterThan(0);
    expect(entries[0].createdAt).toBeGreaterThan(0);
  });

  test('dedupes identical source/result/model and moves it to the top', () => {
    appendTranslationHistory(sample);
    appendTranslationHistory({ ...sample, targetLang: 'ja' });
    const firstRun = loadTranslationHistory();
    expect(firstRun).toHaveLength(2);

    appendTranslationHistory(sample);
    const secondRun = loadTranslationHistory();
    expect(secondRun).toHaveLength(2);
    expect(secondRun[0].targetLang).toBe('zh-Hans');
  });

  test('ignores empty entries and keeps newest first', () => {
    appendTranslationHistory({ ...sample, resultText: '  ' });
    expect(loadTranslationHistory()).toHaveLength(0);

    appendTranslationHistory({ ...sample, resultText: '第一版译文' });
    appendTranslationHistory({ ...sample, resultText: '第二版译文' });
    const entries = loadTranslationHistory();
    expect(entries).toHaveLength(2);
    expect(entries[0].resultText).toBe('第二版译文');
  });

  test('removes and clears entries', () => {
    appendTranslationHistory(sample);
    const entries = loadTranslationHistory();
    removeTranslationHistoryEntry(entries[0].id);
    expect(loadTranslationHistory()).toHaveLength(0);

    appendTranslationHistory(sample);
    clearTranslationHistory();
    expect(loadTranslationHistory()).toHaveLength(0);
  });

  test('caps stored entries at the configured limit', () => {
    for (let index = 0; index < TRANSLATION_HISTORY_LIMIT + 10; index += 1) {
      appendTranslationHistory({ ...sample, resultText: `译文 ${index}` });
    }
    expect(loadTranslationHistory()).toHaveLength(TRANSLATION_HISTORY_LIMIT);
  });
});

describe('translation history time formatting', () => {
  test('labels today entries with a time only', () => {
    const now = new Date();
    now.setHours(14, 5, 0, 0);
    expect(formatTranslationHistoryTime(now.getTime(), now)).toBe('今天 14:05');
  });

  test('labels other days with month and day', () => {
    const now = new Date(2026, 9, 21, 14, 5);
    const other = new Date(2026, 8, 3, 9, 7);
    expect(formatTranslationHistoryTime(other.getTime(), now)).toBe('09-03 09:07');
  });
});
