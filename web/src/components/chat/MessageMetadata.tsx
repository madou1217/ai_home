import { useState } from 'react';
import { CheckOutlined, MobileOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import copyIcon from '@/assets/icons/copy.svg';
import type { ChatMessage } from '@/types';
import {
  formatDurationLabel,
  formatTtftLabel,
  formatTokensPerSecLabel,
} from './message-metrics-format';
import styles from './chat.module.css';

interface Props {
  role: ChatMessage['role'];
  timestamp?: ChatMessage['timestamp'];
  model?: ChatMessage['model'];
  source?: ChatMessage['source'];
  metrics?: ChatMessage['metrics'];
  copyText: string;
  actionsVisible?: boolean;
}

function formatMessageTime(timestamp?: ChatMessage['timestamp']): string {
  if (timestamp == null || timestamp === '') return '';
  const date = dayjs(timestamp);
  return date.isValid() ? date.format('HH:mm') : '';
}

function CopyMessageButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = (event: React.MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <button className={styles.actionBtn} onClick={handleCopy} title="复制">
      {copied
        ? <CheckOutlined style={{ color: '#52c41a' }} />
        : <img src={copyIcon} alt="copy" style={{ width: 14, height: 14 }} />}
    </button>
  );
}

export default function MessageMetadata({
  role,
  timestamp,
  model,
  source,
  metrics,
  copyText,
  actionsVisible = false,
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
        <CopyMessageButton text={copyText} />
      </div>
    </div>
  );
}
