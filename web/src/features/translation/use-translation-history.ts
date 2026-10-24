// 翻译记录的 React 绑定：一个 hook 负责「完成即记录」，另一个负责订阅列表。

import { useCallback, useEffect, useState } from 'react';
import type { TranslationStreamState } from './translation-stream-reducer';
import { AUTO_LANGUAGE } from './translation-utils';
import {
  appendTranslationHistory,
  clearTranslationHistory,
  loadTranslationHistory,
  removeTranslationHistoryEntry,
  subscribeTranslationHistory,
  type TranslationHistoryEntry,
} from './translation-history';

/**
 * 只在一次翻译真正完成（status=done）时落一条记录。
 * 取消 / 失败保留的是半成品，写进记录会让「原文 ↔ 译文」看起来像是完整结果。
 */
export function useTranslationHistoryRecorder(state: TranslationStreamState): void {
  useEffect(() => {
    if (state.status !== 'done') return;
    const request = state.request;
    const meta = state.meta;
    const resultText = String(state.text || '');
    if (!request || !meta || !resultText.trim()) return;
    if (!String(request.text || '').trim()) return;
    appendTranslationHistory({
      sourceText: request.text,
      resultText,
      sourceLang: meta.from || (request.source === AUTO_LANGUAGE ? '' : request.source) || '',
      targetLang: meta.to || request.target || '',
      sourceLabel: meta.fromLabel,
      targetLabel: meta.toLabel,
      model: meta.model,
      provider: meta.provider,
    });
  }, [state.status, state.text, state.meta, state.request]);
}

export interface TranslationHistoryController {
  entries: TranslationHistoryEntry[];
  remove: (id: string) => void;
  clear: () => void;
}

export function useTranslationHistory(): TranslationHistoryController {
  const [entries, setEntries] = useState<TranslationHistoryEntry[]>(() => loadTranslationHistory());

  useEffect(() => {
    setEntries(loadTranslationHistory());
    return subscribeTranslationHistory((next) => setEntries(next));
  }, []);

  const remove = useCallback((id: string) => {
    setEntries(removeTranslationHistoryEntry(id));
  }, []);

  const clear = useCallback(() => {
    setEntries(clearTranslationHistory());
  }, []);

  return { entries, remove, clear };
}
