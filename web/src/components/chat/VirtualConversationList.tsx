import { memo, useMemo, useRef, useState, useEffect } from 'react';
import type { ChatMessage, Session } from '@/types';
import MessageBubble from './MessageBubble';

export interface VirtualConversationListProps {
  messages: ChatMessage[];
  session?: Session | null;
  sessionProvider: string;
  mobile?: boolean;
  onRetry?: (prompt: string) => void;
  onForkSession?: (index: number) => void;
  overscan?: number;
  estimatedItemHeight?: number;
}

/**
 * 吸收 dsh (DeepSeek-Harness) ConversationTimeline 视口裁剪算法
 * 在 200+ 轮超长对话下动态挂载视口内 DOM 节点，结合父容器滚动监听与高度测量，保障 60fps 丝滑渲染
 */
export const VirtualConversationList = memo(function VirtualConversationList({
  messages,
  session,
  sessionProvider,
  mobile = false,
  onRetry,
  onForkSession,
  overscan = 5,
  estimatedItemHeight = 120,
}: VirtualConversationListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(800);
  const itemHeightsRef = useRef<Map<number, number>>(new Map());

  // 监听父滚动容器的滚动事件与尺寸自适应
  useEffect(() => {
    const el = containerRef.current?.parentElement;
    if (!el) return;

    const onScroll = () => {
      setScrollTop(el.scrollTop);
    };

    setScrollTop(el.scrollTop);
    setContainerHeight(el.clientHeight || 800);

    el.addEventListener('scroll', onScroll, { passive: true });

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect.height > 0) {
          setContainerHeight(entry.contentRect.height);
        }
      }
    });
    ro.observe(el);

    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
    };
  }, []);

  // 计算视口可见范围
  const { startIndex, endIndex, topPadding, bottomPadding } = useMemo(() => {
    const total = messages.length;
    if (total <= 30) {
      // 消息较少时不进行裁剪，保留全部节点
      return {
        startIndex: 0,
        endIndex: total,
        topPadding: 0,
        bottomPadding: 0,
      };
    }

    // 估算累积高度
    let currentY = 0;
    let start = 0;
    let end = total;

    for (let i = 0; i < total; i++) {
      const h = itemHeightsRef.current.get(i) || estimatedItemHeight;
      if (currentY + h < Math.max(0, scrollTop - overscan * estimatedItemHeight)) {
        start = i + 1;
      }
      if (currentY > scrollTop + containerHeight + overscan * estimatedItemHeight) {
        end = i;
        break;
      }
      currentY += h;
    }

    start = Math.max(0, Math.min(start, total - 1));
    end = Math.max(start + 1, Math.min(end, total));

    const topPad = start * estimatedItemHeight;
    const botPad = Math.max(0, (total - end) * estimatedItemHeight);

    return {
      startIndex: start,
      endIndex: end,
      topPadding: topPad,
      bottomPadding: botPad,
    };
  }, [containerHeight, estimatedItemHeight, messages.length, overscan, scrollTop]);

  const visibleMessages = useMemo(() => {
    return messages.slice(startIndex, endIndex).map((msg, offset) => {
      const realIndex = startIndex + offset;
      const isFollowup =
        msg.role === 'assistant' &&
        realIndex > 0 &&
        messages[realIndex - 1]?.role === 'assistant';

      return {
        msg,
        realIndex,
        isFollowup,
      };
    });
  }, [endIndex, messages, startIndex]);

  return (
    <div
      ref={containerRef}
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        paddingTop: topPadding > 0 ? `${topPadding}px` : undefined,
        paddingBottom: bottomPadding > 0 ? `${bottomPadding}px` : undefined,
      }}
    >
      {visibleMessages.map(({ msg, realIndex, isFollowup }) => (
        <MessageBubble
          key={`${msg.role}-${realIndex}`}
          isFollowup={isFollowup}
          message={msg}
          provider={sessionProvider}
          session={session}
          mobile={mobile}
          onRetry={
            msg.role === 'assistant' && onRetry
              ? () => onRetry(messages[realIndex - 1]?.content || '')
              : undefined
          }
          onFork={onForkSession ? () => onForkSession(realIndex) : undefined}
        />
      ))}
    </div>
  );
});

export default VirtualConversationList;
