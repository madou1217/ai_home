import { memo, useState, useEffect, useRef, useCallback } from 'react';
import {
  SearchOutlined,
  UpOutlined,
  DownOutlined,
  CloseOutlined,
} from '@ant-design/icons';
import type { ChatMessage } from '@/types';
import styles from './chat.module.css';

export interface InSessionSearchBarProps {
  open: boolean;
  onClose: () => void;
  messages: ChatMessage[];
  onScrollToMessage?: (messageIndex: number) => void;
}

/**
 * HarmonyOS 6 风格会话内悬浮关键词检索胶囊 (InSessionSearchBar)
 * 吸收 dsh 细粒度定位动力学，支持 Cmd+F 唤起、上下轮次跳转与匹配计数
 */
export const InSessionSearchBar = memo(function InSessionSearchBar({
  open,
  onClose,
  messages,
  onScrollToMessage,
}: InSessionSearchBarProps) {
  const [query, setQuery] = useState('');
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // 搜寻匹配的消息索引列表
  const matchedIndices = Array.isArray(messages) && query.trim()
    ? messages
        .map((m, idx) => (String(m.content || '').toLowerCase().includes(query.toLowerCase().trim()) ? idx : -1))
        .filter((idx) => idx !== -1)
    : [];

  useEffect(() => {
    if (open) {
      window.setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      setQuery('');
      setCurrentMatchIndex(0);
    }
  }, [open]);

  useEffect(() => {
    setCurrentMatchIndex(0);
    if (matchedIndices.length > 0 && onScrollToMessage) {
      onScrollToMessage(matchedIndices[0]);
    }
  }, [query]);

  const handleNext = useCallback(() => {
    if (matchedIndices.length === 0) return;
    const next = (currentMatchIndex + 1) % matchedIndices.length;
    setCurrentMatchIndex(next);
    onScrollToMessage?.(matchedIndices[next]);
  }, [currentMatchIndex, matchedIndices, onScrollToMessage]);

  const handlePrev = useCallback(() => {
    if (matchedIndices.length === 0) return;
    const prev = (currentMatchIndex - 1 + matchedIndices.length) % matchedIndices.length;
    setCurrentMatchIndex(prev);
    onScrollToMessage?.(matchedIndices[prev]);
  }, [currentMatchIndex, matchedIndices, onScrollToMessage]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) handlePrev();
      else handleNext();
    }
  };

  if (!open) return null;

  return (
    <div className={styles.inSessionSearchCapsule}>
      <SearchOutlined className={styles.inSessionSearchIcon} />
      <input
        ref={inputRef}
        className={styles.inSessionSearchInput}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="在当前会话中查找... (Enter / Shift+Enter 切换)"
        aria-label="会话内查找"
      />

      <span className={styles.inSessionSearchCount}>
        {query.trim()
          ? matchedIndices.length > 0
            ? `${currentMatchIndex + 1}/${matchedIndices.length}`
            : '无匹配'
          : ''}
      </span>

      <div className={styles.inSessionSearchButtons}>
        <button
          type="button"
          className={styles.inSessionSearchBtn}
          disabled={matchedIndices.length <= 1}
          onClick={handlePrev}
          title="上一个匹配项 (Shift+Enter)"
          aria-label="上一个匹配"
        >
          <UpOutlined />
        </button>
        <button
          type="button"
          className={styles.inSessionSearchBtn}
          disabled={matchedIndices.length <= 1}
          onClick={handleNext}
          title="下一个匹配项 (Enter)"
          aria-label="下一个匹配"
        >
          <DownOutlined />
        </button>
        <button
          type="button"
          className={styles.inSessionSearchBtn}
          onClick={onClose}
          title="关闭 (Esc)"
          aria-label="关闭搜索"
        >
          <CloseOutlined />
        </button>
      </div>
    </div>
  );
});

export default InSessionSearchBar;
