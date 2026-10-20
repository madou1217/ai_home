// 截图/录制全局偏好：默认录制格式、UI 开关集合（布尔矩阵）、捕获范围、水印与录制设置。
// 唯一真相存在 localStorage（键 aih.capture），UI 只通过这里读写，
// 与 aih.theme / aih.hud 同一模式。

import { CAPTURE_FORMAT_CATALOG } from './format-catalog';
import type { CaptureFormatId } from './types';
import {
  DEFAULT_CAPTURE_WATERMARK,
  normalizeCaptureWatermark,
  type CaptureWatermarkSettings
} from './watermark';
import {
  RECORDING_DEFAULT_SETTINGS,
  normalizeRecordingSettings,
  type RecordingSettings
} from './recording-settings';

/**
 * 捕获范围：
 * - full：用同一份 HTML 重新渲染整页（不执行脚本），截图/录制都能拿到完整内容；
 * - live：抓取用户此刻看到的真实预览（脚本、Canvas/WebGL 动效保真），但受视口裁剪。
 */
export type CaptureScope = 'full' | 'live';

export const DEFAULT_CAPTURE_SCOPE: CaptureScope = 'full';

export const CAPTURE_SCOPE_OPTIONS: Array<{
  value: CaptureScope;
  label: string;
  description: string;
}> = [
  {
    value: 'full',
    label: '完整页面',
    description: '重新渲染整页，完整覆盖长页面；不执行脚本（JS 动效请选实时画面）'
  },
  {
    value: 'live',
    label: '实时画面',
    description: '保留脚本与动画，但只覆盖当前可见区域'
  }
];

export interface CapturePreferences {
  /** 全局默认录制/截图格式（PC 与手机弹窗共用）。 */
  defaultFormat: CaptureFormatId;
  /** 格式开关矩阵（关闭的格式不出现在选择器里）。 */
  enabledFormats: Record<CaptureFormatId, boolean>;
  /** 截图与录制的取景范围（聊天预览与弹窗共用）。 */
  captureScope: CaptureScope;
  /** 截图/录制水印（关闭时不绘制）。 */
  watermark: CaptureWatermarkSettings;
  /** 帧率、录制方式、目标帧数与目标时长（聊天预览与弹窗共用）。 */
  recording: RecordingSettings;
}

export const CAPTURE_PREFERENCES_KEY = 'aih.capture';

export function normalizeCaptureScope(value: unknown): CaptureScope {
  return value === 'live' ? 'live' : DEFAULT_CAPTURE_SCOPE;
}

export function createDefaultCapturePreferences(): CapturePreferences {
  const enabledFormats = {} as Record<CaptureFormatId, boolean>;
  for (const format of CAPTURE_FORMAT_CATALOG) {
    enabledFormats[format.id] = format.defaultEnabled === true;
  }
  return {
    defaultFormat: 'png',
    enabledFormats,
    captureScope: DEFAULT_CAPTURE_SCOPE,
    watermark: { ...DEFAULT_CAPTURE_WATERMARK },
    recording: { ...RECORDING_DEFAULT_SETTINGS }
  };
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

/** 把任意快照（旧版本 localStorage / 表单草稿）收敛到合法偏好。 */
export function normalizeCapturePreferences(
  value?: Partial<CapturePreferences> | null
): CapturePreferences {
  const fallback = createDefaultCapturePreferences();
  const enabledFormats = { ...fallback.enabledFormats };
  if (value?.enabledFormats && typeof value.enabledFormats === 'object') {
    for (const format of CAPTURE_FORMAT_CATALOG) {
      const flag = (value.enabledFormats as Record<string, unknown>)[format.id];
      if (typeof flag === 'boolean') enabledFormats[format.id] = flag;
    }
  }
  const defaultFormat = CAPTURE_FORMAT_CATALOG.some((item) => item.id === value?.defaultFormat)
    ? (value?.defaultFormat as CaptureFormatId)
    : fallback.defaultFormat;
  // 默认格式必须处于启用状态，否则回退到第一个启用的格式。
  const effectiveDefault = enabledFormats[defaultFormat]
    ? defaultFormat
    : (CAPTURE_FORMAT_CATALOG.find((item) => enabledFormats[item.id])?.id ?? fallback.defaultFormat);
  return {
    defaultFormat: effectiveDefault,
    enabledFormats,
    captureScope: normalizeCaptureScope(value?.captureScope),
    watermark: normalizeCaptureWatermark(
      value?.watermark && typeof value.watermark === 'object' ? value.watermark : undefined
    ),
    recording: normalizeRecordingSettings(
      value?.recording && typeof value.recording === 'object' ? value.recording : undefined
    )
  };
}

export function parseCapturePreferences(raw: string | null | undefined): CapturePreferences {
  const fallback = createDefaultCapturePreferences();
  if (!raw) return fallback;
  try {
    const value = JSON.parse(raw) as Partial<CapturePreferences>;
    return normalizeCapturePreferences(value);
  } catch {
    return fallback;
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

/** 保存完整偏好并广播；设置页与聊天录制设置弹窗共用。 */
export function saveCapturePreferences(
  prefs: Partial<CapturePreferences>,
  storage: CapturePreferencesStorage | null = defaultStorage()
): CapturePreferences {
  const next = normalizeCapturePreferences(prefs);
  writeCapturePreferences(next, storage);
  notifyCapturePreferences(next);
  return next;
}

/** 只更新录制设置并广播（保留捕获范围、水印等其它偏好）。 */
export function updateRecordingSettings(
  settings: RecordingSettings,
  storage: CapturePreferencesStorage | null = defaultStorage()
): CapturePreferences {
  const current = readCapturePreferences(storage);
  return saveCapturePreferences(
    { ...current, recording: normalizeRecordingSettings(settings) },
    storage
  );
}
