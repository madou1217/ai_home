import { MobileOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import type { ChatMessage } from '@/types';
import MessageIconActions from './MessageIconActions';
import {
  formatDurationLabel,
  formatTtftLabel,
  formatTokensPerSecLabel,
} from './message-metrics-format';
import styles from './message-bubble.module.css';

interface Props {
  role: ChatMessage['role'];
  timestamp?: ChatMessage['timestamp'];
  model?: ChatMessage['model'];
  source?: ChatMessage['source'];
  metrics?: ChatMessage['metrics'];
  copyText: string;
  actionsVisible?: boolean;
  onRetry?: () => void;
  onFork?: () => void;
}

function formatMessageTime(timestamp?: ChatMessage['timestamp']): string {
  if (timestamp == null || timestamp === '') return '';
  const date = dayjs(timestamp);
  return date.isValid() ? date.format('HH:mm') : '';
}

export default function MessageMetadata({
  role,
  timestamp,
  model,
  source,
  metrics,
  copyText,
  actionsVisible = false,
  onRetry,
  onFork,
}: Props) {
  const timeLabel = formatMessageTime(timestamp);
  const modelLabel = String(model || '').trim();
  const isCodexMobile = source === 'codex-mobile';
  const durationLabel = formatDurationLabel(metrics?.durationMs);
  const ttftLabel = formatTtftLabel(metrics?.ttftMs);
  const tpsLabel = formatTokensPerSecLabel(metrics?.tokensPerSec);

  const alignmentClass = role === 'user'
    ? styles.messageMetaRowUser
    : styles.messageMetaRowAssistant;

  return (
    <div className={`${styles.messageMetaRow} ${alignmentClass}`}>
      <div className={styles.messageMetaDetails}>
        {timeLabel ? <span className={styles.messageTime}>{timeLabel}</span> : null}
        {timeLabel && modelLabel ? <span aria-hidden="true">·</span> : null}
        {modelLabel ? (
          <span className={styles.messageModel} title={modelLabel}>{modelLabel}</span>
        ) : null}
        {(timeLabel || modelLabel) && isCodexMobile ? <span aria-hidden="true">·</span> : null}
        {isCodexMobile ? (
          <span className={styles.messageModel} title="来自 Codex Mobile">
            <MobileOutlined /> Codex Mobile
          </span>
        ) : null}
        {role === 'assistant' && durationLabel ? (
          <>
            <span aria-hidden="true">·</span>
            <span className={styles.messageMetricItem} title={metrics?.durationMs ? `总用时 ${metrics.durationMs}ms` : undefined}>
              用时 {durationLabel}
            </span>
          </>
        ) : null}
        {role === 'assistant' && ttftLabel ? (
          <>
            <span aria-hidden="true">·</span>
            <span className={styles.messageMetricItem} title={metrics?.ttftMs ? `首 token 耗时 ${metrics.ttftMs}ms` : undefined}>
              首 token {ttftLabel}
            </span>
          </>
        ) : null}
        {role === 'assistant' && tpsLabel ? (
          <>
            <span aria-hidden="true">·</span>
            <span className={styles.messageMetricItem} title={metrics?.outputTokens ? `输出 ${metrics.outputTokens} tokens` : undefined}>
              {tpsLabel}
            </span>
          </>
        ) : null}
      </div>
      <div className={`${styles.messageMetaActions} ${actionsVisible ? styles.messageMetaActionsVisible : ''}`}>
        <MessageIconActions
          text={copyText}
          role={role}
          model={model}
          timestamp={timestamp}
          onRetry={onRetry}
          onFork={onFork}
          className={actionsVisible ? styles.messageIconActionsVisible : ''}
        />
      </div>
    </div>
  );
}
