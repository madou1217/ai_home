import { InboxOutlined } from '@ant-design/icons';
import { Popconfirm } from 'antd';
import type { Session } from '@/types';
import type { ArchiveActionState } from './session-lifecycle-policy.js';
import styles from './chat.module.css';

interface Props {
  action: ArchiveActionState;
  session: Session;
  onArchive: (session: Session) => Promise<void>;
}

const SessionArchiveAction = ({ action, session, onArchive }: Props) => {
  if (!action.visible) return null;
  if (action.disabled) {
    return (
      <button
        className={styles.archiveBtn}
        disabled
        title={`原生归档不可用：${action.reason}`}
      >
        <InboxOutlined />
      </button>
    );
  }
  return (
    <Popconfirm
      title="归档此会话？"
      description="将通过 provider 原生协议归档"
      onConfirm={async (event) => {
        event?.stopPropagation();
        await onArchive(session);
      }}
      onCancel={(event) => event?.stopPropagation()}
      okText="确定"
      cancelText="取消"
    >
      <button
        className={styles.archiveBtn}
        onClick={(event) => event.stopPropagation()}
        title="原生归档"
      >
        <InboxOutlined />
      </button>
    </Popconfirm>
  );
};

export default SessionArchiveAction;
