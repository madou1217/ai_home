// 截图与录制设置：支持本机草稿编辑、显式保存与跨弹窗同步。
// 状态唯一事实源是 capture-preferences（localStorage: aih.capture），
// 聊天预览按钮与录制弹窗都读取同一份偏好。

import { useEffect, useMemo, useRef, useState } from 'react';
import { Select, Switch } from 'antd';
import { SettingRow, SettingSection } from '@/components/ui/SettingSection';
import SettingStatusTag from '@/components/ui/SettingStatusTag';
import SaveActionBar from '@/components/ui/SaveActionBar';
import InlineNote from '@/components/ui/InlineNote';
import AppButton from '@/components/ui/AppButton';
import type {
  CaptureFormatAvailability,
  CaptureFormatId,
  CapturePreferences,
  CaptureWatermarkPreference,
  RecordingSettings
} from './index';
import {
  CAPTURE_FORMAT_CATALOG,
  createDefaultCapturePreferences,
  describeRecordingSettings,
  isFormatAvailable,
  listRecordableAnimationFormats,
  normalizeCapturePreferences,
  normalizeCaptureWatermark,
  normalizeRecordingSettings,
  notifyCapturePreferences,
  probeCaptureFormatAvailability,
  readCapturePreferences,
  resolveDefaultRecordFormat,
  subscribeCapturePreferences,
  writeCapturePreferences
} from './index';
import RecordingSettingsFields, { recordingSettingsEstimate } from './RecordingSettingsFields';
import PreviewDeviceFields from './PreviewDeviceFields';
import WatermarkSettingsFields from './WatermarkSettingsFields';
import styles from './recording-settings.module.css';

function preferencesEqual(a: CapturePreferences, b: CapturePreferences): boolean {
  if (
    a.defaultFormat !== b.defaultFormat ||
    a.previewDevice !== b.previewDevice ||
    a.watermark.enabled !== b.watermark.enabled ||
    a.recording.mode !== b.recording.mode ||
    a.recording.fps !== b.recording.fps ||
    a.recording.frameCount !== b.recording.frameCount ||
    a.recording.durationSeconds !== b.recording.durationSeconds
  ) {
    return false;
  }
  return CAPTURE_FORMAT_CATALOG.every(
    (format) => a.enabledFormats[format.id] === b.enabledFormats[format.id]
  );
}

function formatLabelById(id: CaptureFormatId | null): string {
  if (!id) return '无可用格式';
  return CAPTURE_FORMAT_CATALOG.find((format) => format.id === id)?.label ?? id;
}

interface CaptureFormatMatrixProps {
  enabledFormats: Record<CaptureFormatId, boolean>;
  availability: CaptureFormatAvailability;
  effectiveDefaultFormat: CaptureFormatId | null;
  onToggle: (id: CaptureFormatId, enabled: boolean) => void;
}

function CaptureFormatMatrix({
  enabledFormats,
  availability,
  effectiveDefaultFormat,
  onToggle
}: CaptureFormatMatrixProps) {
  return (
    <div className={styles.formatList} role="group" aria-label="可用导出格式">
      {CAPTURE_FORMAT_CATALOG.map((format) => {
        const available = isFormatAvailable(format.id, availability);
        const isDefault = format.id === effectiveDefaultFormat;
        const kindLabel = format.kind === 'animation' ? '录制' : '截图';
        return (
          <div
            key={format.id}
            className={`${styles.formatItem}${available ? '' : ` ${styles.formatItemDisabled}`}`}
          >
            <div className={styles.formatMeta}>
              <div className={styles.formatTitleRow}>
                <span className={styles.formatTitle}>{format.label}</span>
                {isDefault ? <span className={styles.formatTag}>默认</span> : null}
              </div>
              <span className={styles.formatSub}>
                {available ? `${kindLabel} · ${format.mimeType}` : `${kindLabel} · 浏览器不支持`}
              </span>
            </div>
            <Switch
              size="small"
              checked={enabledFormats[format.id]}
              disabled={!available}
              aria-label={`启用 ${format.label}`}
              onChange={(checked) => onToggle(format.id, checked)}
            />
          </div>
        );
      })}
    </div>
  );
}

export default function CaptureSettingsCard() {
  const [saved, setSaved] = useState<CapturePreferences>(() => readCapturePreferences());
  const [draft, setDraft] = useState<CapturePreferences>(() => readCapturePreferences());
  const [feedback, setFeedback] = useState<string>('');
  const [feedbackTone, setFeedbackTone] = useState<'muted' | 'success' | 'error'>('muted');
  const dirtyRef = useRef(false);

  const availability = useMemo(() => probeCaptureFormatAvailability(), []);

  const recordOptions = useMemo(
    () => listRecordableAnimationFormats({ availability, preferences: draft }),
    [availability, draft]
  );

  const effectiveDefaultFormat = useMemo(
    () => resolveDefaultRecordFormat(recordOptions, draft),
    [recordOptions, draft]
  );

  const savedRecordOptions = useMemo(
    () => listRecordableAnimationFormats({ availability, preferences: saved }),
    [availability, saved]
  );

  const savedDefaultFormat = useMemo(
    () => resolveDefaultRecordFormat(savedRecordOptions, saved),
    [savedRecordOptions, saved]
  );

  const dirty = useMemo(() => !preferencesEqual(draft, saved), [draft, saved]);
  dirtyRef.current = dirty;

  // 聊天预览里的录制设置弹窗也会写同一份偏好；无本地草稿时自动同步。
  useEffect(() => {
    return subscribeCapturePreferences((incoming) => {
      setSaved(incoming);
      if (!dirtyRef.current) {
        setDraft(incoming);
        setFeedback('已同步其他窗口保存的设置');
        setFeedbackTone('muted');
      } else {
        setFeedback('其他窗口已更新偏好，保存当前草稿将覆盖外部改动');
        setFeedbackTone('muted');
      }
    });
  }, []);

  const updateDraft = (updater: (current: CapturePreferences) => CapturePreferences) => {
    setDraft((current) => normalizeCapturePreferences(updater(current)));
    if (feedbackTone !== 'muted') {
      setFeedback('');
      setFeedbackTone('muted');
    }
  };

  const setRecording = (recording: RecordingSettings) => {
    updateDraft((current) => ({ ...current, recording: normalizeRecordingSettings(recording) }));
  };

  const setWatermark = (watermark: CaptureWatermarkPreference) => {
    updateDraft((current) => ({ ...current, watermark: normalizeCaptureWatermark(watermark) }));
  };

  const setFormatEnabled = (id: CaptureFormatId, enabled: boolean) => {
    updateDraft((current) => {
      const enabledFormats = { ...current.enabledFormats, [id]: enabled };
      let defaultFormat = current.defaultFormat;
      // 关闭（或浏览器不支持）当前默认格式时，切换到仍可用的第一个动画格式。
      if (!enabledFormats[defaultFormat] || !isFormatAvailable(defaultFormat, availability)) {
        const fallback = CAPTURE_FORMAT_CATALOG.find(
          (format) =>
            format.kind === 'animation' &&
            enabledFormats[format.id] &&
            isFormatAvailable(format.id, availability)
        );
        if (fallback) defaultFormat = fallback.id;
      }
      return { ...current, defaultFormat, enabledFormats };
    });
  };

  const handleSave = () => {
    const normalized = normalizeCapturePreferences(draft);
    writeCapturePreferences(normalized);
    notifyCapturePreferences(normalized);
    setSaved(normalized);
    setDraft(normalized);
    setFeedback('已保存并同步到预览与录制弹窗');
    setFeedbackTone('success');
  };

  const handleDiscard = () => {
    setDraft(saved);
    setFeedback('已放弃未保存更改');
    setFeedbackTone('muted');
  };

  const handleRestoreDefaults = () => {
    const defaults = createDefaultCapturePreferences();
    setDraft(defaults);
    setFeedback('已填入默认配置，点击“保存更改”生效');
    setFeedbackTone('muted');
  };

  const isDefaultConfig = useMemo(
    () => preferencesEqual(draft, createDefaultCapturePreferences()),
    [draft]
  );

  const recordingSummary = `${describeRecordingSettings(draft.recording)} · ${recordingSettingsEstimate(draft.recording)}`;
  const persistedRecordingSummary =
    describeRecordingSettings(saved.recording) !== describeRecordingSettings(draft.recording)
      ? `已保存：${describeRecordingSettings(saved.recording)}`
      : undefined;

  return (
    <SettingSection
      title="截图与录制"
      description="HTML 预览与代码视图共用的导出偏好，保存在本机浏览器。"
      status={<SettingStatusTag status={dirty ? 'dirty' : 'applied'} label={dirty ? '未保存' : '已生效'} compact />}
      footer={
        <SaveActionBar
          dirty={dirty}
          onSave={handleSave}
          onReset={handleDiscard}
          cleanSaveLabel="已应用"
          effectSummary="保存在本机浏览器，提交后立即同步到预览与录制弹窗"
          feedback={feedback || undefined}
          feedbackTone={feedbackTone}
          extraActions={
            !isDefaultConfig ? (
              <AppButton size="small" onClick={handleRestoreDefaults} disableDebounce>
                恢复默认
              </AppButton>
            ) : null
          }
        />
      }
    >
      <SettingRow
        title="默认录制格式"
        description="预览区与弹窗录制默认使用的动画格式"
        persistedValue={
          savedDefaultFormat !== effectiveDefaultFormat
            ? `已保存：${formatLabelById(savedDefaultFormat)}`
            : undefined
        }
        control={
          <Select
            size="small"
            className={styles.defaultSelect}
            placeholder="无可用格式"
            aria-label="默认录制格式"
            value={effectiveDefaultFormat ?? undefined}
            options={CAPTURE_FORMAT_CATALOG.filter((format) => format.kind === 'animation').map((format) => ({
              value: format.id,
              label: format.label,
              disabled:
                !draft.enabledFormats[format.id] ||
                !isFormatAvailable(format.id, availability)
            }))}
            onChange={(id: CaptureFormatId) =>
              updateDraft((current) => ({ ...current, defaultFormat: id }))
            }
          />
        }
      />

      <SettingRow
        title="默认预览设备"
        description="聊天录制确认框默认选中的视口尺寸"
        persistedValue={
          saved.previewDevice !== draft.previewDevice
            ? `已保存：${saved.previewDevice === 'mobile' ? '手机预览' : 'PC 预览'}`
            : undefined
        }
        control={
          <PreviewDeviceFields
            value={draft.previewDevice}
            onChange={(previewDevice) =>
              updateDraft((current) => ({ ...current, previewDevice }))
            }
          />
        }
      />

      <SettingRow
        title="录制参数"
        description={recordingSummary}
        persistedValue={persistedRecordingSummary}
        control={
          <RecordingSettingsFields
            compact
            value={draft.recording}
            onChange={setRecording}
          />
        }
      />

      <SettingRow
        title="预览水印"
        description="仅在预览中浅色平铺，不写入导出文件"
        persistedValue={
          saved.watermark.enabled !== draft.watermark.enabled
            ? `已保存：${saved.watermark.enabled ? '已开启' : '已关闭'}`
            : undefined
        }
        control={
          <WatermarkSettingsFields
            compact
            value={draft.watermark}
            onChange={setWatermark}
          />
        }
      />

      <SettingRow
        title="可用格式"
        description="关闭的格式不会出现在导出选择器中"
        layout="stacked"
        control={
          <>
            <CaptureFormatMatrix
              enabledFormats={draft.enabledFormats}
              availability={availability}
              effectiveDefaultFormat={effectiveDefaultFormat}
              onToggle={setFormatEnabled}
            />
            {!effectiveDefaultFormat ? (
              <InlineNote tone="warning" style={{ marginTop: 8 }}>
                当前未启用任何可用的动画格式，录制功能将被禁用。
              </InlineNote>
            ) : null}
          </>
        }
      />
    </SettingSection>
  );
}
