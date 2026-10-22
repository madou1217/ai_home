// 本地翻译记录。
//
// 只写浏览器 localStorage：这是一份「我看过什么」的本机便利记录，不是服务端审计数据。
// 记录原文 / 译文 / 目标语言 / 模型 / 时间，桌面、移动端与划词浮层共用同一份存储，
// 因此任意入口完成的翻译都能在翻译页看到。刻意不记录 provider 凭据、usage 等运行信息。

export interface TranslationHistoryEntry {
  id: string;
  sourceText: string;
  resultText: string;
  /** 解析后的源语言（自动检测时是检测结果） */
  sourceLang: string;
  targetLang: string;
  sourceLabel: string;
  targetLabel: string;
  model: string;
  provider: string;
  createdAt: number;
}

export type TranslationHistoryInput = Omit<TranslationHistoryEntry, 'id' | 'createdAt'>;

export const TRANSLATION_HISTORY_STORAGE_KEY = 'aih.translation.history.v1';
export const TRANSLATION_HISTORY_LIMIT = 100;

type Listener = (entries: TranslationHistoryEntry[]) => void;

const listeners = new Set<Listener>();
let cachedEntries: TranslationHistoryEntry[] | null = null;

function resolveStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch (_error) {
    return null;
  }
}

function createEntryId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch (_error) {
    // 旧浏览器 / 非安全上下文：回落到时间 + 随机串。
  }
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeEntry(raw: unknown): TranslationHistoryEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const sourceText = normalizeString(record.sourceText);
  const resultText = normalizeString(record.resultText);
  if (!sourceText.trim() || !resultText.trim()) return null;
  const createdAt = Number(record.createdAt);
  return {
    id: normalizeString(record.id) || createEntryId(),
    sourceText,
    resultText,
    sourceLang: normalizeString(record.sourceLang),
    targetLang: normalizeString(record.targetLang),
    sourceLabel: normalizeString(record.sourceLabel),
    targetLabel: normalizeString(record.targetLabel),
    model: normalizeString(record.model),
    provider: normalizeString(record.provider),
    createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : Date.now(),
  };
}

function normalizeList(raw: unknown): TranslationHistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: TranslationHistoryEntry[] = [];
  raw.forEach((item) => {
    const entry = normalizeEntry(item);
    if (entry) entries.push(entry);
  });
  return entries.slice(0, TRANSLATION_HISTORY_LIMIT);
}

function notify(entries: TranslationHistoryEntry[]): void {
  listeners.forEach((listener) => {
    try {
      listener(entries);
    } catch (_error) {
      // 单个订阅者出错不应影响其他页面。
    }
  });
}

function persist(entries: TranslationHistoryEntry[]): void {
  const storage = resolveStorage();
  if (!storage) return;
  try {
    storage.setItem(TRANSLATION_HISTORY_STORAGE_KEY, JSON.stringify(entries));
  } catch (_error) {
    // 隐私模式 / 配额满：内存里仍可用，不打断翻译。
  }
}

export function loadTranslationHistory(): TranslationHistoryEntry[] {
  if (cachedEntries) return cachedEntries;
  const storage = resolveStorage();
  if (!storage) {
    cachedEntries = [];
    return cachedEntries;
  }
  try {
    cachedEntries = normalizeList(JSON.parse(storage.getItem(TRANSLATION_HISTORY_STORAGE_KEY) || '[]'));
  } catch (_error) {
    cachedEntries = [];
  }
  return cachedEntries;
}

export function replaceTranslationHistory(entries: TranslationHistoryEntry[]): TranslationHistoryEntry[] {
  const next = normalizeList(entries);
  cachedEntries = next;
  persist(next);
  notify(next);
  return next;
}

export function appendTranslationHistory(input: TranslationHistoryInput): TranslationHistoryEntry[] {
  const entry = normalizeEntry({ ...input, id: createEntryId(), createdAt: Date.now() });
  if (!entry) return loadTranslationHistory();
  const current = loadTranslationHistory();
  // 同一段原文 + 同一译文 + 同一模型只保留一条：重试（或 StrictMode 双执行）
  // 不应该把记录列表刷成重复项，但它会移到最上面并刷新时间。
  const rest = current.filter(
    (item) =>
      !(
        item.sourceText === entry.sourceText &&
        item.resultText === entry.resultText &&
        item.model === entry.model &&
        item.targetLang === entry.targetLang
      ),
  );
  return replaceTranslationHistory([entry, ...rest].slice(0, TRANSLATION_HISTORY_LIMIT));
}

export function removeTranslationHistoryEntry(id: string): TranslationHistoryEntry[] {
  return replaceTranslationHistory(loadTranslationHistory().filter((item) => item.id !== id));
}

export function clearTranslationHistory(): TranslationHistoryEntry[] {
  return replaceTranslationHistory([]);
}

export function subscribeTranslationHistory(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 记录面板里的时间只用于排序辅助，用「今天 14:05 / 10-21 14:05」这种紧凑格式。 */
export function formatTranslationHistoryTime(timestamp: number, now = new Date()): string {
  const date = new Date(Number(timestamp) || 0);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return `今天 ${time}`;
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

/** 仅测试用：清空模块级缓存，避免用例之间互相污染。 */
export function __resetTranslationHistoryCache(): void {
  cachedEntries = null;
  listeners.clear();
}
