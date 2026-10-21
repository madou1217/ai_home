// 聊天预览里的「截图与录制设置」弹窗：与设置页共用字段组件与持久化入口。

import { useEffect, useState } from 'react';
import { Button, Modal, Typography } from 'antd';
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

export default function RecordingSettingsModal({ open, onClose, onSaved }: Props) {
  const [draft, setDraft] = useState<CapturePreferences>(() => readCapturePreferences());

  useEffect(() => {
    if (!open) return;
    setDraft(readCapturePreferences());
  }, [open]);

  const patch = (next: Partial<CapturePreferences>) => {
    setDraft((current) => normalizeCapturePreferences({ ...current, ...next }));
  };

  const handleSave = () => {
    const saved = saveCapturePreferences(draft);
    onSaved?.(saved.recording);
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
      title="截图与录制设置"
      width={520}
      okText="保存"
      cancelText="取消"
      onOk={handleSave}
      onCancel={onClose}
      footer={[
        <Button key="reset" onClick={handleReset}>
          恢复默认
        </Button>,
        <Button key="cancel" onClick={onClose}>
          取消
        </Button>,
        <Button key="save" type="primary" onClick={handleSave}>
          保存
        </Button>
      ]}
    >
      <div className={styles.modalStack}>
        <section className={styles.modalSection}>
          <Typography.Text strong>默认预览设备</Typography.Text>
          <PreviewDeviceFields
            value={draft.previewDevice}
            onChange={(previewDevice) => patch({ previewDevice })}
          />
          <Typography.Text type="secondary">
            从聊天录制时默认选中该设备；确认框里仍可临时切换。
          </Typography.Text>
        </section>

        <section className={styles.modalSection}>
          <Typography.Text strong>录制方式</Typography.Text>
          <RecordingSettingsFields
            value={draft.recording}
            onChange={(recording) => patch({ recording: normalizeRecordingSettings(recording) })}
          />
          <Typography.Text type="secondary">
            {describeRecordingSettings(draft.recording)}（{recordingSettingsEstimate(draft.recording)}）
          </Typography.Text>
        </section>

        <section className={styles.modalSection}>
          <Typography.Text strong>水印</Typography.Text>
          <WatermarkSettingsFields
            value={draft.watermark}
            onChange={(watermark) => patch({ watermark })}
          />
          <Typography.Text type="secondary">
            开启后自动使用当前会话的 Provider · Model，叠加到截图与每一帧录制的右下角。
          </Typography.Text>
        </section>
      </div>
    </Modal>
  );
}
