import { useState } from 'react';
import {
  CopyOutlined,
  CheckOutlined,
  RedoOutlined,
  BranchesOutlined,
  ShareAltOutlined,
} from '@ant-design/icons';
import { Tooltip, message as antdMessage } from 'antd';
import ShareCardModal from './ShareCardModal';
import styles from './chat.module.css';

export interface MessageIconActionsProps {
  text: string;
  role: 'user' | 'assistant';
  model?: string;
  timestamp?: number | string;
  onRetry?: () => void;
  onFork?: () => void;
  className?: string;
}

export default function MessageIconActions({
  text,
  role,
  model,
  timestamp,
  onRetry,
  onFork,
  className = '',
}: MessageIconActionsProps) {
  const [copied, setCopied] = useState(false);
  const [shareModalOpen, setShareModalOpen] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      antdMessage.success('已复制到剪贴板', 1.2);
      window.setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleRetry = (e: React.MouseEvent) => {
    e.stopPropagation();
    onRetry?.();
  };

  const handleFork = (e: React.MouseEvent) => {
    e.stopPropagation();
    onFork?.();
  };

  const handleShare = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShareModalOpen(true);
  };

  return (
    <>
      <ShareCardModal
        open={shareModalOpen}
        onClose={() => setShareModalOpen(false)}
        role={role}
        content={text}
        model={model}
        timestamp={timestamp}
      />
      <div className={`${styles.messageIconActions} ${className}`}>
        <Tooltip title={copied ? '已复制' : '复制内容'} placement="top">
          <button
            type="button"
            className={styles.messageActionIconBtn}
            onClick={handleCopy}
            aria-label="复制"
          >
            {copied ? (
              <CheckOutlined style={{ color: '#52c41a' }} />
            ) : (
              <CopyOutlined />
            )}
          </button>
        </Tooltip>

        <Tooltip title="分享卡片" placement="top">
          <button
            type="button"
            className={styles.messageActionIconBtn}
            onClick={handleShare}
            aria-label="分享"
          >
            <ShareAltOutlined />
          </button>
        </Tooltip>

        {role === 'assistant' && onRetry && (
          <Tooltip title="重新生成" placement="top">
            <button
              type="button"
              className={styles.messageActionIconBtn}
              onClick={handleRetry}
              aria-label="重新生成"
            >
              <RedoOutlined />
            </button>
          </Tooltip>
        )}

        {onFork && (
          <Tooltip title="从此分支新开会话" placement="top">
            <button
              type="button"
              className={styles.messageActionIconBtn}
              onClick={handleFork}
              aria-label="分支会话"
            >
              <BranchesOutlined />
            </button>
          </Tooltip>
        )}
      </div>
    </>
  );
}
