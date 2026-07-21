import { memo, useMemo, type ReactNode } from 'react';
import {
  CheckCircleOutlined,
  CodeOutlined,
  FileTextOutlined,
  InfoCircleOutlined,
  OrderedListOutlined,
  QuestionCircleOutlined,
  RobotOutlined,
  ToolOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import EventBlock, {
  type EventStatus,
  type EventTone,
} from '@/components/chat/EventBlock';
import FileReferenceButton from '@/components/chat/FileReferenceButton';
import MessageMarkdown from '@/components/chat/MessageMarkdown';
import MessageBubble from '@/components/chat/MessageBubble';
import ThinkingBlock from '@/components/chat/ThinkingBlock';
import type { TimelineItem } from '@/chat-runtime';
import type { Provider } from '@/types';
import { collectTimelineFileReferences } from './timeline-file-references';
import styles from './session-runtime.module.css';

interface Props {
  readonly item: TimelineItem;
  readonly provider: Provider;
  readonly projectPath: string;
  readonly onOpenFile: (filePath: string) => void;
  readonly mobile?: boolean;
}

function TimelineItemView({ item, provider, projectPath, onOpenFile, mobile = false }: Props) {
  const filePaths = useMemo(() => collectTimelineFileReferences(item), [item]);
  if (item.kind === 'message') {
    return (
      <MessageBubble
        message={{
          role: item.detail.role,
          content: item.content || '',
          timestamp: item.updatedAt || item.createdAt,
          model: item.detail.model,
        }}
        provider={provider}
        session={{ projectPath }}
        mobile={mobile}
      />
    );
  }
  if (item.kind === 'reasoning') {
    return <ThinkingBlock value={item.content || item.detail.summary || ''} mobile={mobile} />;
  }

  const presentation = eventPresentation(item);
  return (
    <>
      <EventBlock
        tone={presentation.tone}
        icon={presentation.icon}
        title={presentation.title}
        preview={presentation.preview}
        status={statusPresentation(item)}
        defaultOpen={item.status === 'running' || item.status === 'waiting_input'}
        dense={mobile}
      >
        {filePaths.length > 0 ? (
          <div className={styles.fileReferences}>
            {filePaths.map((filePath) => (
              <FileReferenceButton
                key={filePath}
                path={filePath}
                variant="tool"
                onOpenFile={onOpenFile}
              />
            ))}
          </div>
        ) : null}
        {eventBody(item)}
      </EventBlock>
    </>
  );
}

function eventPresentation(item: TimelineItem): {
  title: string; preview?: string; tone: EventTone; icon: ReactNode;
} {
  switch (item.kind) {
    case 'plan': return { title: '计划', preview: item.content, tone: 'plan', icon: <OrderedListOutlined /> };
    case 'shell': return { title: '命令', preview: item.detail.command, tone: 'tool', icon: <CodeOutlined /> };
    case 'tool': return { title: item.detail.name, preview: item.content, tone: 'tool', icon: <ToolOutlined /> };
    case 'diff':
    case 'file_change': return { title: '文件变更', preview: item.content, tone: 'tool', icon: <FileTextOutlined /> };
    case 'question': return { title: '等待回答', preview: item.content, tone: 'ask', icon: <QuestionCircleOutlined /> };
    case 'approval': return { title: '等待审批', preview: item.content, tone: 'ask', icon: <WarningOutlined /> };
    case 'subagent': return { title: '子代理', preview: item.content, tone: 'tool', icon: <RobotOutlined /> };
    case 'error': return { title: '运行错误', preview: item.content, tone: 'notify', icon: <WarningOutlined /> };
    case 'notice': return { title: '运行提示', preview: item.content, tone: 'notify', icon: <InfoCircleOutlined /> };
    default: return { title: kindLabel(item.kind), preview: item.content, tone: 'neutral', icon: <CheckCircleOutlined /> };
  }
}

function eventBody(item: TimelineItem): ReactNode {
  switch (item.kind) {
    case 'plan':
      return item.detail.steps?.length ? (
        <ol className={styles.planSteps}>{item.detail.steps.map((step, index) => (
          <li key={`${step.step}-${index}`} data-status={step.status}>{step.step}</li>
        ))}</ol>
      ) : <MessageMarkdown value={item.content || '计划内容尚未生成'} />;
    case 'shell':
      return <CodeDetail primary={item.detail.command} secondary={item.detail.output || item.content} />;
    case 'tool':
      return <CodeDetail primary={formatUnknown(item.detail.input)} secondary={formatUnknown(item.detail.result)} />;
    case 'diff': return <CodeDetail primary={item.detail.patch || item.content || ''} />;
    case 'file_change': return <CodeDetail primary={item.detail.diff || item.content || formatUnknown(item.detail.changes)} />;
    case 'artifact': return <div>{item.detail.name} · {item.detail.mimeType}</div>;
    case 'attachment': return <div>{item.detail.name} · {item.detail.mimeType}</div>;
    case 'terminal': return <pre className={styles.codeBlock}>{item.content || item.detail.stream}</pre>;
    case 'subagent': return <div>{item.content || `代理 ${item.detail.agentId}`}</div>;
    default: return <MessageMarkdown value={item.content || kindLabel(item.kind)} />;
  }
}

function CodeDetail({ primary, secondary }: { primary: string; secondary?: string }) {
  return (
    <div className={styles.codeStack}>
      {primary ? <pre className={styles.codeBlock}>{primary}</pre> : null}
      {secondary ? <pre className={styles.codeOutput}>{secondary}</pre> : null}
    </div>
  );
}

function statusPresentation(item: TimelineItem): EventStatus {
  const labels = {
    pending: '等待', running: '运行中', waiting_input: '等待输入', completed: '完成',
    failed: '失败', cancelled: '已取消',
  } as const;
  const tones = {
    pending: 'neutral', running: 'running', waiting_input: 'attention', completed: 'success',
    failed: 'failed', cancelled: 'cancelled',
  } as const;
  return { label: labels[item.status], tone: tones[item.status], dot: item.status === 'running' };
}

function formatUnknown(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch (_error) { return String(value); }
}

function kindLabel(kind: TimelineItem['kind']): string {
  return ({
    command: '命令', terminal: '终端', attachment: '附件', artifact: '产物',
  } as Partial<Record<TimelineItem['kind'], string>>)[kind] || '运行事件';
}

export default memo(TimelineItemView);
