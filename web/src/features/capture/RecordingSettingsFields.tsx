// 录制设置表单控件：设置页与聊天预览弹窗共用同一套取值/校验。
// 组件只展示与回调，持久化由调用方通过 capture-preferences 完成。

import { useEffect, useState } from 'react';
import { InputNumber, Segmented } from 'antd';
import {
  RECORDING_FPS_OPTIONS,
  RECORDING_MAX_DURATION_SECONDS,
  RECORDING_MAX_FRAMES,
  RECORDING_MIN_DURATION_SECONDS,
  RECORDING_MIN_FRAMES,
  normalizeRecordingFps,
  normalizeRecordingSettings,
  type RecordingMode,
  type RecordingSettings
} from './recording-settings';
import styles from './recording-settings.module.css';

interface Props {
  value: RecordingSettings;
  onChange: (next: RecordingSettings) => void;
  /** 紧凑布局（设置卡片右侧）。 */
  compact?: boolean;
}

interface NumberFieldProps {
  value: number;
  min: number;
  max: number;
  addonAfter: string;
  ariaLabel: string;
  onCommit: (value: number) => void;
}

const MODE_OPTIONS: Array<{ label: string; value: RecordingMode }> = [
  { label: '手动', value: 'manual' },
  { label: '按帧', value: 'frames' },
  { label: '按时长', value: 'duration' }
];

/**
 * 数字输入保留本地草稿，避免「清空就立刻被 clamp 回旧值」导致无法改数。
 * 只有落在合法区间内才即时提交，越界值在失焦时收敛。
 */
function NumberField({ value, min, max, addonAfter, ariaLabel, onCommit }: NumberFieldProps) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const handleChange = (raw: number | string | null) => {
    const text = raw === null ? '' : String(raw);
    setDraft(text);
    const numeric = Number(text);
    if (text === '' || !Number.isFinite(numeric)) return;
    if (numeric < min || numeric > max) return;
    const next = Math.round(numeric);
    if (next !== value) onCommit(next);
  };

  const handleBlur = () => {
    const numeric = Number(draft);
    if (draft === '' || !Number.isFinite(numeric)) {
      setDraft(String(value));
      return;
    }
    const next = Math.min(max, Math.max(min, Math.round(numeric)));
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };

  return (
    <InputNumber
      size="small"
      min={min}
      max={max}
      precision={0}
      value={draft}
      addonAfter={addonAfter}
      aria-label={ariaLabel}
      onChange={handleChange}
      onBlur={handleBlur}
    />
  );
}

export default function RecordingSettingsFields({ value, onChange, compact = false }: Props) {
  const settings = normalizeRecordingSettings(value);
  const setMode = (mode: RecordingMode) => {
    onChange(normalizeRecordingSettings({ ...settings, mode }));
  };
  return (
    <div className={`${styles.fields} ${compact ? styles.compact : ''}`}>
      <span className={styles.fieldGroup}>
        <span className={styles.fieldLabel}>帧率</span>
        <Segmented
          size="small"
          value={settings.fps}
          options={RECORDING_FPS_OPTIONS.map((fps) => ({ label: `${fps}`, value: fps }))}
          onChange={(value) =>
            onChange(normalizeRecordingSettings({ ...settings, fps: normalizeRecordingFps(value) }))
          }
        />
      </span>
      <Segmented
        size="small"
        value={settings.mode}
        options={MODE_OPTIONS}
        onChange={(mode) => setMode(mode as RecordingMode)}
      />
      {settings.mode === 'frames' && (
        <NumberField
          value={settings.frameCount}
          min={RECORDING_MIN_FRAMES}
          max={RECORDING_MAX_FRAMES}
          addonAfter="帧"
          ariaLabel="录制帧数"
          onCommit={(frameCount) =>
            onChange(normalizeRecordingSettings({ ...settings, frameCount }))
          }
        />
      )}
      {settings.mode === 'duration' && (
        <NumberField
          value={settings.durationSeconds}
          min={RECORDING_MIN_DURATION_SECONDS}
          max={RECORDING_MAX_DURATION_SECONDS}
          addonAfter="秒"
          ariaLabel="录制时长（秒）"
          onCommit={(durationSeconds) =>
            onChange(normalizeRecordingSettings({ ...settings, durationSeconds }))
          }
        />
      )}
    </div>
  );
}

/** 当前设置对应的估算值，放在表单下方做即时反馈。 */
export function recordingSettingsEstimate(value: RecordingSettings): string {
  const settings = normalizeRecordingSettings(value);
  if (settings.mode === 'frames') {
    return `约 ${(settings.frameCount / settings.fps).toFixed(1)} 秒`;
  }
  if (settings.mode === 'duration') {
    return `约 ${Math.round(settings.durationSeconds * settings.fps)} 帧`;
  }
  return '最长 60 秒';
}
