// 录制格式选项的唯一事实源：可选清单 = 启用矩阵 ∩ 浏览器探测能力。
// chat 预览按钮（capture-bridge）与设置页（CaptureSettingsCard）共用。

import type { AnimationCaptureFormatId } from './types';
import type { CaptureFormatAvailability } from './format-availability';
import { isFormatAvailable, probeCaptureFormatAvailability } from './format-availability';
import type { CapturePreferences } from './capture-preferences';
import { readCapturePreferences } from './capture-preferences';
import { listAnimationFormats } from './format-catalog';
import { isAnimationCaptureFormat } from './types';

export interface RecordFormatOption {
  id: AnimationCaptureFormatId;
  label: string;
}

export interface RecordFormatOptionDeps {
  availability?: CaptureFormatAvailability;
  preferences?: CapturePreferences;
}

export function listRecordableAnimationFormats(
  deps: RecordFormatOptionDeps = {}
): RecordFormatOption[] {
  const availability = deps.availability ?? probeCaptureFormatAvailability();
  const prefs = deps.preferences ?? readCapturePreferences();
  return listAnimationFormats()
    .filter((format) => prefs.enabledFormats[format.id] && isFormatAvailable(format.id, availability))
    .flatMap((format) => (isAnimationCaptureFormat(format.id) ? [{ id: format.id, label: format.label }] : []));
}

/** 主按钮默认动作：偏好默认格式（必须启用且在可选清单里），否则清单第一项。 */
export function resolveDefaultRecordFormat(
  options: RecordFormatOption[],
  preferences: CapturePreferences = readCapturePreferences()
): AnimationCaptureFormatId | null {
  const preferred = preferences.defaultFormat;
  if (
    isAnimationCaptureFormat(preferred) &&
    preferences.enabledFormats[preferred] &&
    options.some((option) => option.id === preferred)
  ) {
    return preferred;
  }
  return options[0]?.id ?? null;
}
