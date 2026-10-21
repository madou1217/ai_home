// 设置页「截图与录制」：默认录制格式 + 格式开关矩阵。
// 状态唯一事实源是 capture-preferences（localStorage: aih.capture），
// chat 预览按钮与弹窗录制都读取同一份偏好。

import { useEffect, useMemo, useState } from 'react';
import { Select, Switch } from 'antd';
import SettingsGroupCard, { SettingsItem } from '../../components/settings/SettingsGroupCard';
import type {
  CaptureFormatId,
  CapturePreferences,
  CaptureWatermarkPreference,
  RecordingSettings
} from './index';
import {
  CAPTURE_FORMAT_CATALOG,
  describeRecordingSettings,
  isFormatAvailable,
  listRecordableAnimationFormats,
  normalizeCaptureWatermark,
  normalizeRecordingSettings,
  notifyCapturePreferences,
  probeCaptureFormatAvailability,
  readCapturePreferences,
  resolveDefaultRecordFormat,
  subscribeCapturePreferences,
  writeCapturePreferences
} from './index';
import RecordingSettingsFields from './RecordingSettingsFields';
import WatermarkSettingsFields from './WatermarkSettingsFields';

export default function CaptureSettingsCard() {
  const [preferences, setPreferences] = useState<CapturePreferences>(() => readCapturePreferences());
  const availability = useMemo(() => probeCaptureFormatAvailability(), []);
  const recordOptions = useMemo(
    () => listRecordableAnimationFormats({ availability, preferences }),
    [availability, preferences]
  );
  const effectiveDefaultFormat = useMemo(
    () => resolveDefaultRecordFormat(recordOptions, preferences),
    [recordOptions, preferences]
  );

  // 聊天预览里的录制设置弹窗也会写同一份偏好，这里跟随广播保持同步。
  useEffect(() => subscribeCapturePreferences(setPreferences), []);

  const commit = (next: CapturePreferences) => {
    setPreferences(next);
    writeCapturePreferences(next);
    notifyCapturePreferences(next);
  };

  const setRecording = (recording: RecordingSettings) => {
    commit({ ...preferences, recording: normalizeRecordingSettings(recording) });
  };

  const setWatermark = (watermark: CaptureWatermarkPreference) => {
    commit({ ...preferences, watermark: normalizeCaptureWatermark(watermark) });
  };

  const setFormatEnabled = (id: CaptureFormatId, enabled: boolean) => {
    const enabledFormats = { ...preferences.enabledFormats, [id]: enabled };
    let defaultFormat = preferences.defaultFormat;
    // 关闭（或浏览器不支持）当前默认格式时，把默认切到仍可用的第一个动画格式。
    if (!enabledFormats[defaultFormat] || !isFormatAvailable(defaultFormat, availability)) {
      const fallback = CAPTURE_FORMAT_CATALOG.find(
        (format) =>
          format.kind === 'animation' &&
          enabledFormats[format.id] &&
          isFormatAvailable(format.id, availability)
      );
      if (fallback) defaultFormat = fallback.id;
    }
    commit({ ...preferences, defaultFormat, enabledFormats });
  };

  return (
    <SettingsGroupCard
      title="截图与录制"
      description="HTML 预览与代码视图共用的导出偏好，保存在本机浏览器。"
    >
      <SettingsItem
        title="默认录制格式"
        subtitle="预览区的录制按钮与弹窗录制直接使用该格式"
        action={
          <Select
            size="small"
            style={{ width: 148 }}
            placeholder="无可用格式"
            aria-label="默认录制格式"
            value={effectiveDefaultFormat ?? undefined}
            options={CAPTURE_FORMAT_CATALOG.filter((format) => format.kind === 'animation').map((format) => ({
              value: format.id,
              label: format.label,
              disabled:
                !preferences.enabledFormats[format.id] ||
                !isFormatAvailable(format.id, availability)
            }))}
            onChange={(id: CaptureFormatId) => commit({ ...preferences, defaultFormat: id })}
          />
        }
      />
      <SettingsItem
        title="录制方式"
        subtitle={describeRecordingSettings(preferences.recording)}
        action={
          <RecordingSettingsFields
            compact
            value={preferences.recording}
            onChange={setRecording}
          />
        }
      />
      <SettingsItem
        title="自动水印"
        subtitle="开启后自动使用当前会话的 Provider · Model"
        action={
          <WatermarkSettingsFields
            compact
            value={preferences.watermark}
            onChange={setWatermark}
          />
        }
      />
      {CAPTURE_FORMAT_CATALOG.map((format) => {
        const available = isFormatAvailable(format.id, availability);
        const isDefault = format.id === effectiveDefaultFormat;
        return (
          <SettingsItem
            key={format.id}
            title={isDefault ? `${format.label}（默认）` : format.label}
            subtitle={
              available
                ? `${format.kind === 'animation' ? '录制' : '截图'} · ${format.mimeType}`
                : `${format.kind === 'animation' ? '录制' : '截图'} · 当前浏览器不支持`
            }
            action={
              <Switch
                size="small"
                checked={preferences.enabledFormats[format.id]}
                disabled={!available}
                aria-label={`启用 ${format.label}`}
                onChange={(checked) => setFormatEnabled(format.id, checked)}
              />
            }
          />
        );
      })}
    </SettingsGroupCard>
  );
}
