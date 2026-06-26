import { memo } from 'react';
import { BellOutlined } from '@ant-design/icons';
import FileTypeIcon from './FileTypeIcon';
import EventBlock, { type StatusTone } from './EventBlock';
import evt from './EventBlock.module.css';

type TaskNotification = {
  taskId: string;
  toolUseId: string;
  outputFile: string;
  status: string;
  summary: string;
};

interface TaskNotificationBlockProps {
  value: string;
  onOpenFile?: (path: string, options?: { source?: string }) => void;
}

function parseTaskNotification(value: string): TaskNotification {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return {
      taskId: String(parsed.taskId || '').trim(),
      toolUseId: String(parsed.toolUseId || '').trim(),
      outputFile: String(parsed.outputFile || '').trim(),
      status: String(parsed.status || '').trim(),
      summary: String(parsed.summary || '').trim()
    };
  } catch (_error) {
    return {
      taskId: '',
      toolUseId: '',
      outputFile: '',
      status: '',
      summary: String(value || '').trim()
    };
  }
}

function getStatusTone(status: string): StatusTone {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'success' || normalized === 'completed' || normalized === 'ok') return 'success';
  if (normalized === 'running' || normalized === 'pending') return 'running';
  return 'failed';
}

function TaskNotificationBlock({ value, onOpenFile }: TaskNotificationBlockProps) {
  const notification = parseTaskNotification(value);
  const status = notification.status || 'unknown';
  const tone = getStatusTone(status);
  const canOpenOutput = Boolean(notification.outputFile && onOpenFile);

  return (
    <EventBlock
      tone="notify"
      icon={<BellOutlined />}
      title="任务通知"
      collapsible={false}
      status={{ label: status, tone, dot: tone === 'running' }}
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
