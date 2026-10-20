// 聊天预览里的「录制设置」弹窗：与设置页共用 RecordingSettingsFields 与持久化入口。

import { useEffect, useState } from 'react';
import { Button, Modal, Typography } from 'antd';
import {
  RECORDING_DEFAULT_SETTINGS,
  describeRecordingSettings,
  normalizeRecordingSettings,
  readCapturePreferences,
  updateRecordingSettings,
  type RecordingSettings
} from './index';
import RecordingSettingsFields, { recordingSettingsEstimate } from './RecordingSettingsFields';

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved?: (settings: RecordingSettings) => void;
}

export default function RecordingSettingsModal({ open, onClose, onSaved }: Props) {
  const [draft, setDraft] = useState<RecordingSettings>(
    () => readCapturePreferences().recording
  );

  useEffect(() => {
    if (!open) return;
    setDraft(readCapturePreferences().recording);
  }, [open]);

  const handleSave = () => {
    const normalized = normalizeRecordingSettings(draft);
    updateRecordingSettings(normalized);
    onSaved?.(normalized);
    onClose();
  };

  return (
    <Modal
      open={open}
      title="录制方式与时长"
      okText="保存"
      cancelText="取消"
      onOk={handleSave}
      onCancel={onClose}
      footer={[
        <Button
          key="reset"
          onClick={() => setDraft({ ...RECORDING_DEFAULT_SETTINGS })}
        >
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Typography.Text type="secondary">
          录制中主按钮会变成「停止」，随时可以手动结束。
        </Typography.Text>
        <RecordingSettingsFields value={draft} onChange={setDraft} />
        <Typography.Text type="secondary">
          {describeRecordingSettings(draft)}（{recordingSettingsEstimate(draft)}）
        </Typography.Text>
      </div>
    </Modal>
  );
}
