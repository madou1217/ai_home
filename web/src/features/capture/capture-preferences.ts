// 截图/录制全局偏好：默认录制格式与 UI 开关集合（布尔矩阵）。
// 唯一真相存在 localStorage（键 aih.capture），UI 只通过这里读写，
// 与 aih.theme / aih.hud 同一模式。

import { CAPTURE_FORMAT_CATALOG } from './format-catalog';
import type { CaptureFormatId } from './types';

export interface CapturePreferences {
  /** 全局默认录制/截图格式（PC 与手机弹窗共用）。 */
  defaultFormat: CaptureFormatId;
  /** 格式开关矩阵（关闭的格式不出现在选择器里）。 */
  enabledFormats: Record<CaptureFormatId, boolean>;
}

export const CAPTURE_PREFERENCES_KEY = 'aih.capture';

export function createDefaultCapturePreferences(): CapturePreferences {
  const enabledFormats = {} as Record<CaptureFormatId, boolean>;
  for (const format of CAPTURE_FORMAT_CATALOG) {
    enabledFormats[format.id] = format.defaultEnabled === true;
  }
  return { defaultFormat: 'png', enabledFormats };
}

type Listener = (prefs: CapturePreferences) => void;

export interface CapturePreferencesStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): CapturePreferencesStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function parseCapturePreferences(raw: string | null | undefined): CapturePreferences {
  const fallback = createDefaultCapturePreferences();
  if (!raw) return fallback;
  try {
    const value = JSON.parse(raw) as Partial<CapturePreferences>;
    const enabledFormats = { ...fallback.enabledFormats };
    if (value.enabledFormats && typeof value.enabledFormats === 'object') {
      for (const format of CAPTURE_FORMAT_CATALOG) {
        const flag = (value.enabledFormats as Record<string, unknown>)[format.id];
        if (typeof flag === 'boolean') enabledFormats[format.id] = flag;
      }
    }
    const defaultFormat = CAPTURE_FORMAT_CATALOG.some((item) => item.id === value.defaultFormat)
      ? (value.defaultFormat as CaptureFormatId)
      : fallback.defaultFormat;
    // 默认格式必须处于启用状态，否则回退到第一个启用的格式。
    const effectiveDefault = enabledFormats[defaultFormat]
      ? defaultFormat
      : (CAPTURE_FORMAT_CATALOG.find((item) => enabledFormats[item.id])?.id ?? fallback.defaultFormat);
    return { defaultFormat: effectiveDefault, enabledFormats };
  } catch {
    return { ...fallback, enabledFormats: { ...fallback.enabledFormats } };
  }
}

export function readCapturePreferences(storage: CapturePreferencesStorage | null = defaultStorage()): CapturePreferences {
  try {
    return parseCapturePreferences(storage?.getItem(CAPTURE_PREFERENCES_KEY) ?? null);
  } catch {
    return createDefaultCapturePreferences();
  }
}

export function writeCapturePreferences(
  prefs: CapturePreferences,
  storage: CapturePreferencesStorage | null = defaultStorage()
): void {
  try {
    storage?.setItem(CAPTURE_PREFERENCES_KEY, JSON.stringify(prefs));
  } catch {
    // 隐私模式等存储不可用时静默放弃
  }
}

const listeners = new Set<Listener>();

export function subscribeCapturePreferences(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyCapturePreferences(prefs: CapturePreferences): void {
  for (const listener of listeners) listener(prefs);
}
