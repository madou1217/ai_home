import { Modal } from 'antd';
import Button from '@/components/ui/AppButton';
import type { InteractionField, QuestionViewModel } from './interaction-view-model';
import styles from './session-runtime.module.css';

export function AutoResolutionStatus({
  phase,
  remainingSeconds,
}: {
  readonly phase: string;
  readonly remainingSeconds?: number;
}) {
  if (phase === 'countdown') {
    return (
      <p className={styles.autoResolutionStatus} role="status">
        {remainingSeconds} 秒内无操作将自动继续
      </p>
    );
  }
  if (phase === 'snoozed') {
    return <p className={styles.autoResolutionStatus}>已暂停自动继续</p>;
  }
  if (phase === 'expired') {
    return <p className={styles.autoResolutionStatus}>正在按未回答状态自动继续…</p>;
  }
  return null;
}

export function QuestionButtons({
  view, busy, disabled, onAction,
}: {
  readonly view: QuestionViewModel;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onAction: (action: 'submit' | 'decline' | 'cancel') => Promise<void>;
}) {
  return (
    <footer>
      {view.actions.includes('cancel') ? (
        <Button disabled={disabled || busy} onClick={() => void onAction('cancel')}>取消</Button>
      ) : null}
      {view.actions.includes('decline') ? (
        <Button disabled={disabled || busy} onClick={() => void onAction('decline')}>拒绝</Button>
      ) : null}
      {view.actions.includes('submit') ? (
        <Button
          type="primary"
          disabled={disabled}
          loading={busy}
          onClick={() => void onAction('submit')}
        >提交</Button>
      ) : null}
    </footer>
  );
}

export function UnansweredConfirmation({
  fields,
  busy,
  disabled,
  onCancel,
  onConfirm,
}: {
  readonly fields: readonly InteractionField[];
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => Promise<void>;
}) {
  return (
    <Modal
      open={fields.length > 0}
      title="仍有问题未回答"
      okText="继续提交"
      cancelText="返回填写"
      confirmLoading={busy}
      okButtonProps={{ disabled: disabled || busy }}
      onCancel={onCancel}
      onOk={onConfirm}
    >
      <p>以下问题将以未回答状态提交：</p>
      <ul>{fields.map((field) => <li key={field.id}>{field.label}</li>)}</ul>
    </Modal>
  );
}
