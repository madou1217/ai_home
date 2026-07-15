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

function extractXmlTag(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  return match ? match[1].trim() : '';
}

// claude 原生 <task-notification> 是 XML（<task-id>/<tool-use-id>/<output-file>/<status>/<summary>），
// 不是 JSON。旧实现只 JSON.parse → 失败即把整段 XML 当 summary 显示（卡片里露原始标签、状态/ID 全空）。
// 这里优先按 XML 解析，兼容个别已转 JSON 的路径，最后才整段兜底。
function parseTaskNotification(value: string): TaskNotification {
  const raw = String(value || '').trim();

  const taskId = extractXmlTag(raw, 'task-id');
  const status = extractXmlTag(raw, 'status');
  if (taskId || status || raw.includes('<summary>')) {
    return {
      taskId,
      toolUseId: extractXmlTag(raw, 'tool-use-id'),
      outputFile: extractXmlTag(raw, 'output-file'),
      status,
      summary: extractXmlTag(raw, 'summary')
    };
  }

  try {
    const parsed = JSON.parse(raw || '{}');
    if (parsed && typeof parsed === 'object') {
      return {
        taskId: String(parsed.taskId ?? parsed['task-id'] ?? '').trim(),
        toolUseId: String(parsed.toolUseId ?? parsed['tool-use-id'] ?? '').trim(),
        outputFile: String(parsed.outputFile ?? parsed['output-file'] ?? '').trim(),
        status: String(parsed.status || '').trim(),
        summary: String(parsed.summary || '').trim()
      };
    }
  } catch (_error) { /* 非 JSON 也非结构化 XML，整段作为 summary 兜底 */ }

  return { taskId: '', toolUseId: '', outputFile: '', status: '', summary: raw };
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
