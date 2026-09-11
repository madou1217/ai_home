import { useEffect, useState } from 'react';
import { Input, Modal, Select, Tooltip, message } from 'antd';
import { SettingOutlined } from '@ant-design/icons';
import { useSessionSelector, type SessionProjectionStore } from '@/chat-runtime';
import type { SessionRuntimeActions } from './session-runtime-actions';
import styles from './session-runtime.module.css';

export default function ChatSessionSettings({ store, actions }: {
  readonly store: SessionProjectionStore;
  readonly actions: SessionRuntimeActions;
}) {
  const projection = useSessionSelector(store, (value) => value);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [role, setRole] = useState('');
  const [percent, setPercent] = useState(80);
  useEffect(() => {
    if (!open) return;
    setRole(String(projection.policy.systemPrompt || ''));
    setPercent(Number(projection.policy.autoCompactPercent) || 80);
  }, [open, projection.policy.systemPrompt, projection.policy.autoCompactPercent]);
  const idle = projection.state === 'idle';
  const save = async () => {
    setSaving(true);
    try {
      if (role !== (projection.policy.systemPrompt || '')) await actions.setPolicy('systemPrompt', role);
      if (percent !== (projection.policy.autoCompactPercent || 80)) await actions.setPolicy('autoCompactPercent', percent);
      setOpen(false);
    } catch (error) { message.error(error instanceof Error ? error.message : '保存失败'); }
    finally { setSaving(false); }
  };
  return <>
    <Tooltip title={projection.policy.systemPrompt ? '会话设置 · 已设定角色' : '会话设置'}>
      <button type="button" className={styles.composerToolButton} aria-label="会话设置"
        data-active={Boolean(projection.policy.systemPrompt) || undefined}
        onClick={() => setOpen(true)}>
        <SettingOutlined />
      </button>
    </Tooltip>
    <Modal title="会话设置" open={open} onCancel={() => setOpen(false)} onOk={() => void save()}
      okText="保存" cancelText="取消" confirmLoading={saving} okButtonProps={{ disabled: !idle }}>
      <div className={styles.chatSettingsFields}>
        <label htmlFor="chat-system-prompt">角色与回答偏好</label>
        <Input.TextArea id="chat-system-prompt" value={role} onChange={(event) => setRole(event.target.value)}
          placeholder="默认是通用助手。例如：你是一位语言老师，用简洁中文讲解，并给出例句。"
          maxLength={16000} autoSize={{ minRows: 4, maxRows: 10 }} disabled={!idle} />
        <span className={styles.chatSettingsHint}>保存后从下一轮生效，分支会继承此设置。留空使用默认助手。</span>
        <label htmlFor="chat-compact-percent">自动压缩</label>
        <Select id="chat-compact-percent" aria-label="自动压缩阈值" value={percent} disabled={!idle}
          onChange={setPercent} options={[50, 60, 70, 75, 80, 85, 90].map((value) => ({ value,
            label: `达到模型上下文窗口的 ${value}% 时压缩${value === 80 ? '（默认）' : ''}` }))} />
        <span className={styles.chatSettingsHint}>保留对话记录，通过摘要为后续回答腾出空间。也可以随时手动压缩。</span>
        {!idle ? <span role="status" className={styles.chatSettingsHint}>本轮结束后可修改设置。</span> : null}
      </div>
    </Modal>
  </>;
}
