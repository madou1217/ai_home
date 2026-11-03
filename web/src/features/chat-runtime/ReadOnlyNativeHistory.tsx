import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Empty } from 'antd';
import Button from '@/components/ui/AppButton';
import MessageBubble from '@/components/chat/MessageBubble';
import chatStyles from '@/components/chat/message-area.module.css';
import { sessionsAPI } from '@/services/api';
import type { ChatMessage, Provider, Session } from '@/types';
import styles from './session-runtime.module.css';

// 只读原生历史（由 legacy MessageArea 的「不可续写原生会话」分支迁入）：
// provider 没有原生会话运行时（kimi / kiro 等）时，WebUI 只能查看它在原生客户端里的历史。
// 打开即停在最新消息，滚到顶部加载更早一页；输入区换成原因说明（resolveNativeSessionWriteBlock）。
// 不走 canonical 会话（没有驱动可接管），也不发任何推理请求。

const PAGE_LIMIT = 40;

export default function ReadOnlyNativeHistory({ session, notice, mobile = false }: {
  readonly session: Session;
  readonly notice: string;
  readonly mobile?: boolean;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [cursor, setCursor] = useState<number | undefined>(undefined);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<{ height: number; top: number } | null>(null);
  const firstPageRef = useRef(true);

  const load = useCallback(async (before?: number): Promise<void> => {
    setLoading(true);
    setError('');
    try {
      const bundle = await sessionsAPI.getSessionMessagesBundle(
        session.provider,
        session.id,
        session.projectDirName,
        { ...(before === undefined ? {} : { before }), limit: PAGE_LIMIT, accountRef: session.accountRef },
      );
      setMessages((current) => (before === undefined ? bundle.messages : [...bundle.messages, ...current]));
      setCursor(bundle.start);
      setHasMore(bundle.hasMore);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '读取历史失败');
    } finally {
      setLoading(false);
    }
  }, [session.accountRef, session.id, session.projectDirName, session.provider]);

  useEffect(() => {
    firstPageRef.current = true;
    setMessages([]);
    void load();
  }, [load]);

  // 首屏贴底；加载更早一页后保持当前看到的那条不动。
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (firstPageRef.current && messages.length > 0) {
      firstPageRef.current = false;
      container.scrollTop = container.scrollHeight;
      return;
    }
    const anchor = anchorRef.current;
    if (anchor) {
      anchorRef.current = null;
      container.scrollTop = anchor.top + (container.scrollHeight - anchor.height);
    }
  }, [messages]);

  const loadEarlier = useCallback((): void => {
    const container = containerRef.current;
    if (!hasMore || loading || cursor === undefined || !container) return;
    anchorRef.current = { height: container.scrollHeight, top: container.scrollTop };
    void load(cursor);
  }, [cursor, hasMore, load, loading]);

  return (
    <main className={styles.workspace} data-runtime-workspace="true">
      <div
        ref={containerRef}
        className={`${styles.timeline} ${chatStyles.messageSurface} ${mobile ? chatStyles.messageSurfaceMobile : ''}`}
        onScroll={(event) => { if (event.currentTarget.scrollTop < 160) loadEarlier(); }}
      >
        {hasMore ? (
          <div className={styles.loadEarlier}>
            <Button size="small" loading={loading} onClick={loadEarlier}>
              {loading ? '正在加载更早记录' : '加载更早记录'}
            </Button>
          </div>
        ) : null}
        {error ? <div className={styles.runtimeNotice} role="alert" data-danger="true">{error}</div> : null}
        {!loading && !error && messages.length === 0 ? (
          <Empty className={styles.emptyTimeline} image={Empty.PRESENTED_IMAGE_SIMPLE} description="这个会话还没有可显示的消息" />
        ) : null}
        {messages.map((message, index) => (
          <MessageBubble
            key={`${message.timestamp || ''}-${index}`}
            message={message}
            provider={session.provider as Provider}
            session={session}
            mobile={mobile}
          />
        ))}
      </div>
      <div className={styles.workspaceDock}>
        <div className={styles.runtimeNotice} role="status">{notice}</div>
      </div>
    </main>
  );
}
