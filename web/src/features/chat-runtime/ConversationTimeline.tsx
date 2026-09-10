import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Empty, message as toast } from 'antd';
import Button from '@/components/ui/AppButton';
import type {
  SessionProjection,
  SessionRuntimeController,
  TimelineItem,
} from '@/chat-runtime';
import { useSessionSelector } from '@/chat-runtime';
import type { Provider, Session } from '@/types';
import { MessageOperation } from './message-operation';
import FileDrawer, { type FileDrawerTab } from '@/components/chat/FileDrawer';
import InSessionSearchBar from '@/components/chat/InSessionSearchBar';
import { IN_SESSION_SEARCH_OPEN_EVENT } from '@/components/chat/chat-global-shortcuts';
import type { ChatMessage } from '@/types';
import { basenameLike, getFileTabKey } from '@/components/chat/file-reference-utils';
import { formatStreamFailureText } from '@/components/chat/provider-pending-policy.js';
import chatStyles from '@/components/chat/message-area.module.css';
import type { CommittedTimelineObserver } from './browser-first-text-paint-probe';
import { sessionConnectionPresentation } from './session-connection-presentation';
import { selectTimelinePresentation } from './timeline-presentation';
import TimelineItemView from './TimelineItemView';
import TurnFeedback from './TurnFeedback';
import TurnProgress from './TurnProgress';
import type { SessionRuntimeActions } from './session-runtime-actions';
import styles from './session-runtime.module.css';

interface Props {
  readonly controller: SessionRuntimeController;
  readonly actions: SessionRuntimeActions;
  readonly firstTextPaintProbe: CommittedTimelineObserver;
  readonly provider: Provider;
  readonly projectPath: string;
  readonly workspaceMode?: string;
  readonly mobile?: boolean;
  readonly onBranchSession?: (session: Session) => void;
}

export default function ConversationTimeline({
  controller,
  actions,
  firstTextPaintProbe,
  provider,
  projectPath,
  workspaceMode,
  mobile = false,
  onBranchSession,
}: Props) {
  const items = useSessionSelector(controller.store, selectItems);
  const presentation = useSessionSelector(controller.store, selectTimelinePresentation);
  const hasMore = useSessionSelector(controller.store, selectHasMore);
  const streamFailure = useSessionSelector(controller.store, selectStreamFailure);
  const gap = useSessionSelector(controller.store, selectGap);
  const connectionState = useSessionSelector(controller.store, selectConnectionState);
  const connection = sessionConnectionPresentation(connectionState);
  const viewport = useTimelineViewport(controller, items);
  const preview = useTimelineFilePreview(projectPath);
  const idle = useSessionSelector(controller.store, (projection) => projection.state === 'idle');
  const operation = useMemo(() => new MessageOperation(actions, controller.sessionId), [actions, controller.sessionId]);
  const [branching, setBranching] = useState(false);
  // 会话内检索(Cmd/Ctrl+F,事件源在 Chat.tsx;快捷键事实源见 chat-global-shortcuts)。
  // 消息序与 DOM 中 [data-chat-anchor-key] 行序一致:每条 message item 恰好渲染一行。
  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => {
    const openSearch = () => setSearchOpen(true);
    window.addEventListener(IN_SESSION_SEARCH_OPEN_EVENT, openSearch);
    return () => window.removeEventListener(IN_SESSION_SEARCH_OPEN_EVENT, openSearch);
  }, []);
  const searchMessages = useMemo<ChatMessage[]>(
    () => presentation.items
      .filter((item) => item.kind === 'message')
      .map((item) => ({ role: item.detail.role, content: item.content || '' } as ChatMessage)),
    [presentation.items],
  );
  const scrollToSearchedMessage = useCallback((index: number) => {
    const container = viewport.containerRef.current;
    const target = container?.querySelectorAll('[data-chat-anchor-key]')?.[index];
    if (target instanceof HTMLElement) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [viewport.containerRef]);
  const operate = async (kind: 'fork' | 'regenerate', itemId: string) => {
    if (branching) return;
    setBranching(true);
    try {
      const session = await operation.execute(kind, itemId);
      window.dispatchEvent(new Event('aih:chat-sessions-changed'));
      onBranchSession?.(session);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '消息操作失败，请重试');
    } finally { setBranching(false); }
  };
  const messageActions = workspaceMode === 'chat' && idle && connection.interactive && !branching && onBranchSession;
  useLayoutEffect(() => {
    firstTextPaintProbe.observeCommittedTimeline(items);
  }, [firstTextPaintProbe, items]);

  return (
    <>
      <InSessionSearchBar
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        messages={searchMessages}
        onScrollToMessage={scrollToSearchedMessage}
      />
      <div
        ref={viewport.containerRef}
        className={`${styles.timeline} ${chatStyles.messageSurface} ${mobile ? chatStyles.messageSurfaceMobile : ''}`}
        onScroll={viewport.handleScroll}
      >
      {hasMore ? (
        <div className={styles.loadEarlier}>
          <Button size="small" loading={viewport.loadingEarlier} onClick={() => void viewport.loadEarlier()}>
            加载更早记录
          </Button>
        </div>
      ) : null}
      {connection.notice ? <RuntimeNotice text={connection.notice} sticky /> : null}
      {gap && connectionState !== 'resyncing'
        ? <RuntimeNotice text="事件序列正在重新同步…" />
        : null}
      {streamFailure ? (
        <RuntimeNotice
          text={formatStreamFailureText(streamFailure, provider)}
          danger={!streamFailure.retryable}
        />
      ) : null}
      {presentation.items.length === 0 ? (
        <Empty
          className={styles.emptyTimeline}
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={<span>{workspaceMode === 'chat'
            ? '发送消息开始对话，上下文会随会话保留'
            : '开始一次原生会话，计划、工具和审批会实时出现在这里'}</span>}
        />
      ) : presentation.items.map((item) => (
        workspaceMode === 'chat' && item.kind === 'notice'
          && ['contextCompaction', 'context_compacted'].includes(item.detail.code || '')
          ? <RuntimeNotice key={item.id} text={item.status === 'completed'
            ? '上下文已压缩' : '正在压缩上下文…'} />
          : <TimelineItemView
          key={item.id}
          item={item}
          reasoningRunning={item.id === presentation.runningReasoningId}
          provider={provider}
          projectPath={projectPath}
          onOpenFile={preview.openFile}
          mobile={mobile}
          progress={item.id === presentation.progressItemId ? <TurnProgress store={controller.store} /> : undefined}
          onFork={messageActions && item.kind === 'message' && item.status === 'completed'
            ? () => void operate('fork', item.id) : undefined}
          onRetry={messageActions && item.kind === 'message' && item.detail.role === 'assistant' && item.status === 'completed'
            ? () => void operate('regenerate', item.id) : undefined}
        />
      ))}
      {!presentation.progressItemId ? <div className={styles.turnProgressPlaceholder}>
        <TurnProgress store={controller.store} />
      </div> : null}
      <TurnFeedback store={controller.store} actions={actions} />
      </div>
      <FileDrawer
        open={preview.open}
        tabs={preview.tabs}
        activeKey={preview.activeKey}
        onClose={preview.close}
        onChangeTab={preview.setActiveKey}
      />
    </>
  );
}

function useTimelineFilePreview(projectPath: string) {
  const [tabs, setTabs] = useState<FileDrawerTab[]>([]);
  const [activeKey, setActiveKey] = useState('');
  const [open, setOpen] = useState(false);
  const openFile = useCallback((filePath: string): void => {
    setTabs((current) => current.some((tab) => tab.path === filePath)
      ? current
      : [...current, { path: filePath, title: basenameLike(filePath), projectPath }]);
    setActiveKey(getFileTabKey(filePath));
    setOpen(true);
  }, [projectPath]);
  const close = useCallback(() => setOpen(false), []);
  return { activeKey, close, open, openFile, setActiveKey, tabs };
}

function useTimelineViewport(
  controller: SessionRuntimeController,
  items: readonly TimelineItem[],
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const [loadingEarlier, setLoadingEarlier] = useState(false);

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const container = containerRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [items]);

  const handleScroll = useCallback((): void => {
    const container = containerRef.current;
    if (!container) return;
    const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
    stickToBottomRef.current = distance < 96;
  }, []);

  const loadEarlier = useCallback(async (): Promise<void> => {
    const container = containerRef.current;
    const previousHeight = container?.scrollHeight || 0;
    setLoadingEarlier(true);
    try {
      await controller.loadEarlier();
      requestAnimationFrame(() => {
        if (container) container.scrollTop += container.scrollHeight - previousHeight;
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '加载更早记录失败');
    } finally {
      setLoadingEarlier(false);
    }
  }, [controller]);
  return { containerRef, loadingEarlier, handleScroll, loadEarlier };
}

function RuntimeNotice({
  text,
  danger = false,
  sticky = false,
}: {
  text: string;
  danger?: boolean;
  sticky?: boolean;
}) {
  return (
    <div
      className={styles.runtimeNotice}
      data-danger={danger}
      data-sticky={sticky}
      role="status"
      aria-live="polite"
    >
      {text}
    </div>
  );
}

function selectItems(projection: SessionProjection): readonly TimelineItem[] {
  return projection.items;
}

function selectHasMore(projection: SessionProjection): boolean {
  return projection.timelineHasMore;
}

function selectStreamFailure(projection: SessionProjection): SessionProjection['streamFailure'] {
  return projection.streamFailure;
}

function selectGap(projection: SessionProjection): SessionProjection['gap'] {
  return projection.gap;
}

function selectConnectionState(projection: SessionProjection): SessionProjection['connectionState'] {
  return projection.connectionState;
}
