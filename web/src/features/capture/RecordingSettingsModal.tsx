// 聊天触发独立窗口录制前的设置弹窗：复用 CaptureSettingsCard 的字段组件，
// 变更通过 capture-preferences 与设置页实时同步。

import { useEffect, useMemo, useState } from 'react';
import { Modal } from 'antd';
import AppButton from '@/components/ui/AppButton';
import SettingStatusTag from '@/components/ui/SettingStatusTag';
import {
  createDefaultCapturePreferences,
  describeRecordingSettings,
  normalizeCapturePreferences,
  normalizeRecordingSettings,
  readCapturePreferences,
  saveCapturePreferences,
  type CapturePreferences,
  type RecordingSettings
} from './index';
import RecordingSettingsFields, { recordingSettingsEstimate } from './RecordingSettingsFields';
import PreviewDeviceFields from './PreviewDeviceFields';
import WatermarkSettingsFields from './WatermarkSettingsFields';
import styles from './recording-settings.module.css';

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved?: (settings: RecordingSettings) => void;
}

function modalFieldsEqual(a: CapturePreferences, b: CapturePreferences): boolean {
  return (
    a.previewDevice === b.previewDevice &&
    a.watermark.enabled === b.watermark.enabled &&
    a.recording.mode === b.recording.mode &&
    a.recording.fps === b.recording.fps &&
    a.recording.frameCount === b.recording.frameCount &&
    a.recording.durationSeconds === b.recording.durationSeconds
  );
}

export default function RecordingSettingsModal({ open, onClose, onSaved }: Props) {
  const [saved, setSaved] = useState<CapturePreferences>(() => readCapturePreferences());
  const [draft, setDraft] = useState<CapturePreferences>(() => readCapturePreferences());

  useEffect(() => {
    if (!open) return;
    const current = readCapturePreferences();
    setSaved(current);
    setDraft(current);
  }, [open]);

  const dirty = useMemo(() => !modalFieldsEqual(draft, saved), [draft, saved]);

  const patch = (next: Partial<CapturePreferences>) => {
    setDraft((current) => normalizeCapturePreferences({ ...current, ...next }));
  };

  const handleSave = () => {
    const persisted = saveCapturePreferences(draft);
    setSaved(persisted);
    onSaved?.(persisted.recording);
    onClose();
  };

  const handleReset = () => {
    const defaults = createDefaultCapturePreferences();
    setDraft((current) => ({
      ...current,
      recording: { ...defaults.recording },
      previewDevice: defaults.previewDevice,
      watermark: { ...defaults.watermark }
    }));
  };

  return (
    <Modal
      open={open}
      title="录制偏好"
      width={500}
      onCancel={onClose}
      footer={
        <div className={styles.modalFooter}>
          <SettingStatusTag status={dirty ? 'dirty' : 'saved'} label={dirty ? '有未保存更改' : '与本机一致'} compact />
          <div className={styles.modalFooterActions}>
            <AppButton size="small" onClick={handleReset} disableDebounce>
              恢复默认
            </AppButton>
            <AppButton size="small" onClick={onClose} disableDebounce>
              取消
            </AppButton>
            <AppButton size="small" type="primary" onClick={handleSave}>
              保存并应用
            </AppButton>
          </div>
        </div>
      }
    >
      <div className={styles.modalStack}>
        <section className={styles.modalSection}>
          <div className={styles.modalSectionHeader}>
            <span className={styles.modalSectionTitle}>默认预览设备</span>
          </div>
          <PreviewDeviceFields
            value={draft.previewDevice}
            onChange={(previewDevice) => patch({ previewDevice })}
          />
          <p className={styles.modalSectionHint}>
            录制确认框默认选中的视口尺寸，打开后仍可临时切换。
          </p>
        </section>

        <section className={styles.modalSection}>
          <div className={styles.modalSectionHeader}>
            <span className={styles.modalSectionTitle}>录制参数</span>
          </div>
          <RecordingSettingsFields
            value={draft.recording}
            onChange={(recording) => patch({ recording: normalizeRecordingSettings(recording) })}
          />
          <p className={styles.modalSectionHint}>
            {describeRecordingSettings(draft.recording)} · {recordingSettingsEstimate(draft.recording)}
          </p>
        </section>

        <section className={styles.modalSection}>
          <div className={styles.modalSectionHeader}>
            <span className={styles.modalSectionTitle}>预览水印</span>
          </div>
          <WatermarkSettingsFields
            value={draft.watermark}
            onChange={(watermark) => patch({ watermark })}
          />
          <p className={styles.modalSectionHint}>
            仅在预览中浅色平铺当前 Provider · Model，不写入导出文件。
          </p>
        </section>
      </div>
    </Modal>
  );
}
