import { memo } from 'react';
import { BellOutlined } from '@ant-design/icons';
import FileTypeIcon from './FileTypeIcon';
import EventBlock from './EventBlock';
import evt from './EventBlock.module.css';
import { getTaskNotificationStatus, parseTaskNotification } from './task-notification';

interface TaskNotificationBlockProps {
  value: string;
  onOpenFile?: (path: string, options?: { source?: string }) => void;
}

function TaskNotificationBlock({ value, onOpenFile }: TaskNotificationBlockProps) {
  const notification = parseTaskNotification(value);
  const status = getTaskNotificationStatus(notification.status);
  const canOpenOutput = Boolean(notification.outputFile && onOpenFile);

  return (
    <EventBlock
      tone="notify"
      icon={<BellOutlined />}
      title="任务通知"
      collapsible={false}
      status={status}
      meta={notification.taskId ? <span className={evt.metaText}>{notification.taskId}</span> : null}
      aria-label="任务通知"
    >
      {notification.summary ? <div className={evt.prose}>{notification.summary}</div> : null}
      {notification.toolUseId || notification.outputFile ? (
        <div className={evt.chips} style={{ marginTop: 'var(--space-5)', alignItems: 'center' }}>
          {notification.toolUseId ? <span className={evt.metaText}>{notification.toolUseId}</span> : null}
          {notification.outputFile ? (
            <button
              type="button"
              className={evt.inlineAction}
              disabled={!canOpenOutput}
              onClick={() => onOpenFile?.(notification.outputFile)}
            >
              <FileTypeIcon filePath={notification.outputFile} size="small" />
              <span>output</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </EventBlock>
  );
}

export default memo(TaskNotificationBlock);
