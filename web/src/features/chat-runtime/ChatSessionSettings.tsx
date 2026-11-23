import { useEffect, useState } from 'react';
import { Input, Modal, Select, Tooltip } from 'antd';
import { SettingOutlined } from '@ant-design/icons';
import { useSessionSelector, type SessionProjectionStore } from '@/chat-runtime';
import SettingStatusTag, { type SettingStatusState } from '@/components/ui/SettingStatusTag';
import SaveActionBar from '@/components/ui/SaveActionBar';
import type { SessionRuntimeActions } from './session-runtime-actions';
import styles from './session-runtime.module.css';

interface ChatSettingsFeedback {
  tone: 'success' | 'error';
  text: string;
}

function summarizePersistedRole(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) return '未设定角色（使用默认通用助手）';
  const singleLine = trimmed.replace(/\s+/g, ' ');
  return singleLine.length > 42 ? `${singleLine.slice(0, 42)}…` : singleLine;
}

export default function ChatSessionSettings({ store, actions }: {
  readonly store: SessionProjectionStore;
  readonly actions: SessionRuntimeActions;
}) {
  const projection = useSessionSelector(store, (value) => value);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [role, setRole] = useState('');
  const [percent, setPercent] = useState(80);
  const [feedback, setFeedback] = useState<ChatSettingsFeedback | null>(null);

  const persistedRole = String(projection.policy.systemPrompt || '');
  const persistedPercent = Number(projection.policy.autoCompactPercent) || 80;
  const hasPersistedRole = persistedRole.trim().length > 0;
  const idle = projection.state === 'idle';

  useEffect(() => {
    if (!open) return;
    setRole(persistedRole);
    setPercent(persistedPercent);
    setFeedback(null);
  }, [open, persistedRole, persistedPercent]);

  const roleDirty = role !== persistedRole;
  const percentDirty = percent !== persistedPercent;
  const dirty = roleDirty || percentDirty;

  const roleStatus: SettingStatusState = roleDirty
    ? 'dirty'
    : hasPersistedRole
      ? 'applied'
      : 'unset';

  const roleStatusLabel = roleDirty
    ? (role.trim() ? '待保存角色' : '待清除角色')
    : hasPersistedRole
      ? '已设定角色'
      : '未设定角色';

  const modalSaveStatus: SettingStatusState = saving
    ? 'saving'
    : feedback?.tone === 'error'
      ? 'error'
      : dirty
        ? 'dirty'
        : 'saved';

  const save = async () => {
    if (!idle || !dirty || saving) return;
    setSaving(true);
    setFeedback(null);
    try {
      if (roleDirty) await actions.setPolicy('systemPrompt', role);
      if (percentDirty) await actions.setPolicy('autoCompactPercent', percent);
      setFeedback({
        tone: 'success',
        text: role.trim()
          ? '已保存，下轮对话按新角色与阈值生效'
          : '已保存，下轮对话使用默认通用助手'
      });
    } catch (error) {
      setFeedback({
        tone: 'error',
        text: error instanceof Error ? error.message : '保存失败'
      });
    } finally {
      setSaving(false);
    }
  };

  const resetDraft = () => {
    setRole(persistedRole);
    setPercent(persistedPercent);
    setFeedback(null);
  };

  const triggerTooltip = hasPersistedRole
    ? `会话设置 · 已设定角色（自动压缩 ${persistedPercent}%）`
    : `会话设置 · 未设定角色（默认通用助手，自动压缩 ${persistedPercent}%）`;

  return <>
    <div className={styles.chatSettingsTrigger}>
      <SettingStatusTag
        status={hasPersistedRole ? 'applied' : 'unset'}
        label={hasPersistedRole ? '已设定角色' : '未设定角色'}
        detail={summarizePersistedRole(persistedRole)}
        compact
      />
      <Tooltip title={triggerTooltip}>
        <button
          type="button"
          className={styles.composerToolButton}
          aria-label={hasPersistedRole ? '会话设置（已设定角色）' : '会话设置（未设定角色）'}
          data-active={hasPersistedRole || undefined}
          onClick={() => setOpen(true)}
        >
          <SettingOutlined />
        </button>
      </Tooltip>
    </div>

    <Modal
      title={
        <div className={styles.chatSettingsModalTitle}>
          <span>会话设置</span>
          <SettingStatusTag status={roleStatus} label={roleStatusLabel} compact />
        </div>
      }
      open={open}
      onCancel={() => setOpen(false)}
      footer={
        <SaveActionBar
          dirty={dirty}
          saving={saving}
          disabled={!idle}
          onSave={() => void save()}
          onReset={resetDraft}
          status={modalSaveStatus}
          saveLabel="保存会话设置"
          cleanSaveLabel="已保存"
          effectSummary={!idle ? '本轮对话结束后才可修改' : '保存后从下一轮生效，分支会继承'}
          feedback={feedback?.text}
          feedbackTone={feedback?.tone ?? 'muted'}
        />
      }
    >
      <div className={styles.chatSettingsFields}>
        <div className={styles.chatSettingsFieldHead}>
          <label htmlFor="chat-system-prompt">角色与回答偏好</label>
          <SettingStatusTag status={roleStatus} label={roleStatusLabel} compact />
        </div>
        <span className={styles.chatSettingsPersisted}>
          当前生效：{summarizePersistedRole(persistedRole)}
        </span>
        <Input.TextArea
          id="chat-system-prompt"
          value={role}
          onChange={(event) => {
            setRole(event.target.value);
            if (feedback) setFeedback(null);
          }}
          placeholder="留空则使用默认通用助手。例如：用简洁中文讲解，并给出例句。"
          maxLength={16000}
          autoSize={{ minRows: 4, maxRows: 10 }}
          disabled={!idle}
        />
        <span className={styles.chatSettingsHint}>留空并保存可清除自定义角色，恢复默认通用助手。</span>

        <div className={styles.chatSettingsFieldHead}>
          <label htmlFor="chat-compact-percent">自动压缩阈值</label>
          <SettingStatusTag
            status={percentDirty ? 'dirty' : 'applied'}
            label={percentDirty ? '未保存' : `已生效 ${persistedPercent}%`}
            compact
          />
        </div>
        <Select
          id="chat-compact-percent"
          aria-label="自动压缩阈值"
          value={percent}
          disabled={!idle}
          onChange={(value) => {
            setPercent(value);
            if (feedback) setFeedback(null);
          }}
          options={[50, 60, 70, 75, 80, 85, 90].map((value) => ({
            value,
            label: `上下文达到 ${value}% 时自动压缩${value === 80 ? '（默认）' : ''}`
          }))}
        />
        <span className={styles.chatSettingsHint}>自动摘要历史记录以腾出上下文空间，也可随时手动压缩。</span>
        {!idle ? <span role="status" className={styles.chatSettingsHint}>当前对话运行中，本轮结束后可保存修改。</span> : null}
      </div>
    </Modal>
  </>;
}
