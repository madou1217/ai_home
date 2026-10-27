import type { TranslationLanguage } from '@/types';

export type TranslationTargetPolicy = 'saved' | 'explicit' | 'confirm' | 'same-language';
export type LanguageIntentState = 'ready' | 'needs_target_confirmation' | 'same_language' | 'unsupported';

export interface LanguageIntentInput {
  source?: string | null;
  target?: string | null;
  detected?: string | null;
  confidence?: string | null;
  targetPolicy?: TranslationTargetPolicy | null;
  /**
   * The selected execution route can infer the source language in the model
   * request. When this is true, a known target is enough to start translation;
   * an empty or low-confidence local detector result must not block the user.
   */
  allowAutoSource?: boolean;
}

export interface LanguageIntentResult {
  state: LanguageIntentState;
  source: string;
  target: string;
  reason: string;
}

const AUTO_LANGUAGE = 'auto';
const ALIASES: Record<string, string> = {
  zh: 'zh-Hans',
  'zh-cn': 'zh-Hans',
  'zh-sg': 'zh-Hans',
  'zh-hans-cn': 'zh-Hans',
  'zh-tw': 'zh-Hant',
  'zh-hk': 'zh-Hant',
  'zh-mo': 'zh-Hant',
  'zh-hant-tw': 'zh-Hant',
  cn: 'zh-Hans',
  chinese: 'zh-Hans',
  english: 'en',
  japanese: 'ja',
  korean: 'ko',
  french: 'fr',
  german: 'de',
  spanish: 'es',
  portuguese: 'pt',
  russian: 'ru',
  italian: 'it',
  arabic: 'ar',
  thai: 'th',
  vietnamese: 'vi',
  indonesian: 'id',
  turkish: 'tr',
  dutch: 'nl',
  polish: 'pl',
  hindi: 'hi',
};

function supplied(value: unknown): boolean {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function normalize(value: unknown, languages: readonly TranslationLanguage[]): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const lower = raw.toLowerCase().replace(/_/g, '-');
  if (lower === AUTO_LANGUAGE) return AUTO_LANGUAGE;
  const alias = ALIASES[lower];
  if (alias) return alias;
  return languages.find((language) => language.code.toLowerCase() === lower)?.code || '';
}

export function resolveLanguageIntent(
  input: LanguageIntentInput,
  languages: readonly TranslationLanguage[],
): LanguageIntentResult {
  const rawSource = supplied(input.source) ? String(input.source).trim() : AUTO_LANGUAGE;
  const source = normalize(rawSource, languages);
  const rawTarget = supplied(input.target) ? String(input.target).trim() : '';
  const target = normalize(rawTarget, languages);
  const detected = normalize(input.detected, languages);

  if ((supplied(rawSource) && !source) || (supplied(rawTarget) && !target)
    || (supplied(input.detected) && !detected)) {
    return { state: 'unsupported', source: '', target: '', reason: 'unsupported_language' };
  }
  if (!target || target === AUTO_LANGUAGE) {
    return {
      state: 'needs_target_confirmation',
      source: source === AUTO_LANGUAGE ? detected : source,
      target: '',
      reason: 'target_required',
    };
  }

  const resolvedSource = source === AUTO_LANGUAGE ? detected : source;
  if (source === AUTO_LANGUAGE && input.allowAutoSource === true && input.targetPolicy !== 'confirm'
    && (!resolvedSource || String(input.confidence || '').toLowerCase() === 'low')) {
    return { state: 'ready', source: AUTO_LANGUAGE, target, reason: 'provider_auto_source' };
  }
  if (!resolvedSource) {
    return { state: 'needs_target_confirmation', source: '', target, reason: 'source_detection_required' };
  }
  if (String(input.confidence || '').toLowerCase() === 'low' && input.targetPolicy !== 'explicit') {
    return { state: 'needs_target_confirmation', source: resolvedSource, target, reason: 'low_confidence' };
  }
  if (resolvedSource === target && input.targetPolicy !== 'explicit') {
    return { state: 'same_language', source: resolvedSource, target, reason: 'same_language' };
  }
  return { state: 'ready', source: resolvedSource, target, reason: 'ready' };
}
