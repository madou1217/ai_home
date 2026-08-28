import { memo, useEffect, useMemo, useRef } from 'react';
import { BulbOutlined } from '@ant-design/icons';
import MessageMarkdown from './MessageMarkdown';
import EventBlock from './EventBlock';
import { useThrottledVisualUpdate } from './use-throttled-visual-update';
import evt from './EventBlock.module.css';

interface Props {
  value: string;
  mobile?: boolean;
  components?: any;
  running?: boolean;
}

function firstLine(text: string): string {
  const newline = text.indexOf('\n');
  return newline === -1 ? text : text.slice(0, newline);
}

function latestLine(text: string): string {
  const visible = text.trimEnd();
  const newline = visible.lastIndexOf('\n');
  return newline === -1 ? visible : visible.slice(newline + 1);
}

function ThinkingBlock({ value, mobile = false, components, running = false }: Props) {
  const summaryRef = useRef<HTMLSpanElement>(null);
  const raw = String(value || '');

  // 流式运行状态显示最新一行，并向右平滑滚动跟随；结束后显示首行概括
  const summary = useMemo(() => {
    if (!raw.trim()) return '正在思考...';
    return running ? latestLine(raw) : firstLine(raw);
  }, [raw, running]);

  const scheduleSummaryScroll = useThrottledVisualUpdate(() => {
    const element = summaryRef.current;
    if (!element) return;
    element.scrollLeft = running ? element.scrollWidth - element.clientWidth : 0;
  });

  useEffect(() => {
    scheduleSummaryScroll();
  }, [running, scheduleSummaryScroll, summary]);

  const previewNode = (
    <span
      ref={summaryRef}
      style={{
        display: 'inline-block',
        maxWidth: '100%',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        textOverflow: running ? 'clip' : 'ellipsis',
        verticalAlign: 'bottom',
        color: 'var(--color-muted)',
      }}
    >
      {summary}
    </span>
  );

  return (
    <EventBlock
      tone="thinking"
      icon={<BulbOutlined />}
      title="思考"
      preview={previewNode}
      dense={mobile}
      status={running ? { label: '思考中', tone: 'running', dot: true } : undefined}
      aria-label="思考过程"
    >
      <div className={`${evt.prose} ${evt.scroll}`}>
        <MessageMarkdown value={value} components={components} forceMarkdown />
      </div>
    </EventBlock>
  );
}

export default memo(ThinkingBlock);
