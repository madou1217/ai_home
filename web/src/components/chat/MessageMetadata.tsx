import { MobileOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import type { ReactNode } from 'react';
import type { ChatMessage, Provider } from '@/types';
import MessageIconActions from './MessageIconActions';
import { getProviderLabel } from './provider-registry';
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
  provider?: Provider;
  effort?: ChatMessage['effort'];
  source?: ChatMessage['source'];
  metrics?: ChatMessage['metrics'];
  copyText: string;
  actionsVisible?: boolean;
  onRetry?: () => void;
  onFork?: () => void;
  progress?: ReactNode;
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
  provider,
  effort,
  source,
  metrics,
  copyText,
  actionsVisible = false,
  onRetry,
  onFork,
  progress,
}: Props) {
  const timeLabel = formatMessageTime(timestamp);
  const modelLabel = String(model || '').trim();
  const providerLabel = role === 'assistant' && provider ? String(getProviderLabel(provider) || '').trim() : '';
  // 推理强度只显示本轮真正生效的档位；没有档位（或未记录）就留空，不显示占位符。
  const effortLabel = String(effort || '').trim();
  const isCodexMobile = source === 'codex-mobile';
  const durationLabel = progress ? '' : formatDurationLabel(metrics?.durationMs);
  const ttftLabel = progress ? '' : formatTtftLabel(metrics?.ttftMs);
  const tpsLabel = progress ? '' : formatTokensPerSecLabel(metrics?.tokensPerSec);

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
        {providerLabel ? (
          <>
            {timeLabel || modelLabel ? <span aria-hidden="true">·</span> : null}
            <span className={styles.messageModel} title={providerLabel}>{providerLabel}</span>
          </>
        ) : null}
        {effortLabel ? (
          <>
            {timeLabel || modelLabel || providerLabel ? <span aria-hidden="true">·</span> : null}
            <span className={styles.messageEffort} title={`推理强度 ${effortLabel}`}>{effortLabel}</span>
          </>
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
            <span className={styles.messageMetricItem} title={metrics?.durationMs === undefined ? undefined : `总用时 ${metrics.durationMs}ms`}>
              用时 {durationLabel}
            </span>
          </>
        ) : null}
        {role === 'assistant' && ttftLabel ? (
          <>
            <span aria-hidden="true">·</span>
            <span className={styles.messageMetricItem} title={metrics?.ttftMs === undefined ? undefined : `首个思考或正文输出耗时 ${metrics.ttftMs}ms`}>
              首字 {ttftLabel}
            </span>
          </>
        ) : null}
        {role === 'assistant' && tpsLabel ? (
          <>
            <span aria-hidden="true">·</span>
            <span className={styles.messageMetricItem} title={metrics?.outputTokens === undefined ? undefined : `输出 ${metrics.outputTokens} tokens`}>
              {tpsLabel}
            </span>
          </>
        ) : null}
        {role === 'assistant' && progress ? <span className={`${styles.messageMetricItem} ${styles.messageMetaProgress}`}>{progress}</span> : null}
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
