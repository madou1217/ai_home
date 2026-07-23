import { useState } from 'react';
import { CheckOutlined, MobileOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import copyIcon from '@/assets/icons/copy.svg';
import type { ChatMessage } from '@/types';
import styles from './chat.module.css';

interface Props {
  role: ChatMessage['role'];
  timestamp?: ChatMessage['timestamp'];
  model?: ChatMessage['model'];
  source?: ChatMessage['source'];
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
  copyText,
  actionsVisible = false,
}: Props) {
  const timeLabel = formatMessageTime(timestamp);
  const modelLabel = String(model || '').trim();
  const isCodexMobile = source === 'codex-mobile';
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
      </div>
      <div className={`${styles.messageMetaActions} ${actionsVisible ? styles.messageMetaActionsVisible : ''}`}>
        <CopyMessageButton text={copyText} />
      </div>
    </div>
  );
}
