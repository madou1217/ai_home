import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Empty, Tooltip, message as toast } from 'antd';
import { ArrowDownOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import type {
  SessionProjection,
  SessionRuntimeController,
  TimelineItem,
  CommandCatalogEntry,
} from '@/chat-runtime';
import { useSessionSelector } from '@/chat-runtime';
import type { Provider, Session } from '@/types';
import { MessageOperation, messageOperationAvailable, messageOperationFailure } from './message-operation';
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
import { useSwitchFade } from '@/hooks/use-switch-fade';
import { useAppendEnter } from '@/hooks/use-append-enter';

interface Props {
  readonly controller: SessionRuntimeController;
  readonly actions: SessionRuntimeActions;
  readonly firstTextPaintProbe: CommittedTimelineObserver;
  readonly provider: Provider;
  readonly projectPath: string;
  readonly workspaceMode?: string;
  readonly mobile?: boolean;
  readonly onBranchSession?: (session: Session) => void;
  readonly readOnly?: boolean;
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
  readOnly = false,
}: Props) {
  const items = useSessionSelector(controller.store, selectItems);
  const presentation = useSessionSelector(controller.store, selectTimelinePresentation);
  const hasMore = useSessionSelector(controller.store, selectHasMore);
  const streamFailure = useSessionSelector(controller.store, selectStreamFailure);
  const gap = useSessionSelector(controller.store, selectGap);
  const connectionState = useSessionSelector(controller.store, selectConnectionState);
  const connection = sessionConnectionPresentation(connectionState);
  const viewport = useTimelineViewport(controller, items, hasMore);
  // 切换会话时整条时间线内容换掉：一次只碰 opacity 的淡入表达「切换」。
  // key 记在模块级，会话外壳整块重挂载（controller 换实例）时同样能判断出来。
  useSwitchFade(viewport.containerRef, controller.sessionId);
  // 追加一条消息：只让新出现的消息行做一次淡入上移，历史消息不动。
  // 消息 id 序列是「纯追加」判定的依据；切会话/加载更早记录不满足前缀，不会误播。
  const messageKeys = useMemo(
    () => presentation.items.filter((item) => item.kind === 'message').map((item) => item.id),
    [presentation.items],
  );
  useAppendEnter(viewport.containerRef, messageKeys, controller.sessionId, {
    selector: '[data-chat-anchor-key]',
  });
  const preview = useTimelineFilePreview(projectPath);
  const idle = useSessionSelector(controller.store, (projection) => projection.state === 'idle');
  const operation = useMemo(() => new MessageOperation(actions, controller.sessionId), [actions, controller.sessionId]);
  const [branching, setBranching] = useState(false);
  const [commands, setCommands] = useState<readonly CommandCatalogEntry[]>([]);
  useEffect(() => {
    let disposed = false;
    setCommands([]);
    if (connection.interactive) void controller.getCommandCatalog().then(
      (catalog) => { if (!disposed) setCommands(catalog); },
      () => { if (!disposed) setCommands([]); },
    );
    return () => { disposed = true; };
  }, [controller, connection.interactive]);
  // 会话内检索(Cmd/Ctrl+F,事件源在 Chat.tsx;快捷键事实源见 chat-global-shortcuts)。
  // 消息序与 DOM 中 [data-chat-anchor-key] 行序一致:每条 message item 恰好渲染一行。
  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => {
    const openSearch = () => setSearchOpen(true);
    window.addEventListener(IN_SESSION_SEARCH_OPEN_EVENT, openSearch);
    return () => window.removeEventListener(IN_SESSION_SEARCH_OPEN_EVENT, openSearch);
  }, []);
  // 用户消息锚点：每条用户消息一个刻度，点击直接跳过去（长会话里快速切换回某个问题）。
  const userAnchors = useMemo(
    () => presentation.items
      .filter((item) => item.kind === 'message' && item.detail.role === 'user')
      .map((item) => ({ id: item.id, label: (item.content || '').trim().replace(/\s+/g, ' ').slice(0, 60) || '（附件）' })),
    [presentation.items],
  );
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
      toast.error(messageOperationFailure(error));
    } finally { setBranching(false); }
  };
  const messageActions = idle && connection.interactive && !readOnly && !branching && onBranchSession;
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
      <div className={styles.timelineFrame}>
      <div
        ref={viewport.containerRef}
        className={`${styles.timeline} ${chatStyles.messageSurface} ${mobile ? chatStyles.messageSurfaceMobile : ''}`}
        onScroll={viewport.handleScroll}
      >
      {hasMore ? (
        <div className={styles.loadEarlier}>
          {/* 滚到顶部会自动加载；按钮保留给键盘与「不想滚」的场景 */}
          <Button size="small" loading={viewport.loadingEarlier} onClick={() => void viewport.loadEarlier()}>
            {viewport.loadingEarlier ? '正在加载更早记录' : '加载更早记录'}
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
          onFork={messageActions && messageOperationAvailable(commands, item, 'fork')
            ? () => void operate('fork', item.id) : undefined}
          onRetry={messageActions && messageOperationAvailable(commands, item, 'regenerate')
            ? () => void operate('regenerate', item.id) : undefined}
        />
      ))}
      {!presentation.progressItemId ? <div className={styles.turnProgressPlaceholder}>
        <TurnProgress store={controller.store} />
      </div> : null}
      <TurnFeedback store={controller.store} actions={actions} readOnly={readOnly} />
      </div>
      {!mobile && userAnchors.length > 1 ? (
        <nav className={styles.userAnchorRail} aria-label="跳转到用户消息">
          {userAnchors.map((anchor, index) => (
            <Tooltip key={anchor.id} title={anchor.label} placement="left" mouseEnterDelay={0.05}>
              <button
                type="button"
                className={styles.userAnchorTick}
                data-active={anchor.id === viewport.activeAnchorId ? 'true' : undefined}
                aria-label={`第 ${index + 1} 条提问：${anchor.label}`}
                onClick={() => viewport.scrollToItem(anchor.id)}
              />
            </Tooltip>
          ))}
        </nav>
      ) : null}
      {viewport.awayFromBottom ? (
        <button
          type="button"
          className={styles.scrollToLatest}
          onClick={viewport.scrollToBottom}
          aria-label="回到最新消息"
        >
          <ArrowDownOutlined />
          {viewport.unseenCount > 0 ? <span className={styles.scrollToLatestCount}>{viewport.unseenCount}</span> : null}
        </button>
      ) : null}
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

// 时间线视口（聊天标准）：
//  - 打开会话即停在最新消息（底部），不从顶部往下滚；
//  - 贴底时新内容/图片变高持续跟随，离开底部后不再打扰阅读；
//  - 滚到顶部自动加载更早历史，插入后保持当前看到的那条不动；
//  - 离开底部出现「回到最新」按钮，并提示其间新增了几条；
//  - 用户消息锚点：跳转 + 当前所在问题高亮。
// 所有程序化定位都用瞬时 scrollTop：容器的 smooth 行为会让钉底与历史插入时的位置补偿失效。
function useTimelineViewport(
  controller: SessionRuntimeController,
  items: readonly TimelineItem[],
  hasMore: boolean,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const loadingEarlierRef = useRef(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const [unseenCount, setUnseenCount] = useState(0);
  const [activeAnchorId, setActiveAnchorId] = useState<string>();
  const seenCountRef = useRef(items.length);

  const jumpToBottom = useCallback((): void => {
    const container = containerRef.current;
    if (!container) return;
    container.style.scrollBehavior = 'auto';
    container.scrollTop = container.scrollHeight;
    container.style.scrollBehavior = '';
  }, []);

  // 切会话：重新贴底。
  useLayoutEffect(() => {
    stickToBottomRef.current = true;
    seenCountRef.current = 0;
    setAwayFromBottom(false);
    setUnseenCount(0);
    jumpToBottom();
  }, [controller.sessionId, jumpToBottom]);

  // 新内容：贴底就跟随；不贴底就累计「未读」。
  useLayoutEffect(() => {
    if (stickToBottomRef.current) {
      jumpToBottom();
      seenCountRef.current = items.length;
      setUnseenCount(0);
    } else if (items.length > seenCountRef.current) {
      setUnseenCount(items.length - seenCountRef.current);
    }
  }, [items, jumpToBottom]);

  // 内容异步变高（图片、代码高亮、markdown 二次渲染）时，贴底则继续钉底。
  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => { if (stickToBottomRef.current) jumpToBottom(); });
    Array.from(container.children).forEach((child) => observer.observe(child));
    const mutations = new MutationObserver(() => {
      Array.from(container.children).forEach((child) => observer.observe(child));
    });
    mutations.observe(container, { childList: true });
    return () => { observer.disconnect(); mutations.disconnect(); };
  }, [jumpToBottom]);

  const loadEarlier = useCallback(async (): Promise<void> => {
    if (loadingEarlierRef.current) return;
    const container = containerRef.current;
    const previousHeight = container?.scrollHeight || 0;
    const previousTop = container?.scrollTop || 0;
    loadingEarlierRef.current = true;
    setLoadingEarlier(true);
    try {
      await controller.loadEarlier();
      // 等更早的记录真正渲染进 DOM，再按新增高度补偿，保持用户正在看的那条不动。
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!container) return;
        container.style.scrollBehavior = 'auto';
        container.scrollTop = previousTop + (container.scrollHeight - previousHeight);
        container.style.scrollBehavior = '';
      }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '加载更早记录失败');
    } finally {
      loadingEarlierRef.current = false;
      setLoadingEarlier(false);
    }
  }, [controller]);

  const updateActiveAnchor = useCallback((container: HTMLDivElement): void => {
    const top = container.getBoundingClientRect().top + 24;
    let active: string | undefined;
    container.querySelectorAll<HTMLElement>('[data-chat-anchor-key][data-chat-role="user"]').forEach((node) => {
      if (node.getBoundingClientRect().top <= top) active = node.dataset.chatAnchorKey;
    });
    setActiveAnchorId(active);
  }, []);

  const scrollFrameRef = useRef(0);
  const handleScroll = useCallback((): void => {
    if (scrollFrameRef.current) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = 0;
      const container = containerRef.current;
      if (!container) return;
      const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
      const atBottom = distance < 96;
      stickToBottomRef.current = atBottom;
      setAwayFromBottom(distance > 240);
      if (atBottom) { seenCountRef.current = items.length; setUnseenCount(0); }
      if (hasMore && container.scrollTop < 160) void loadEarlier();
      updateActiveAnchor(container);
    });
  }, [hasMore, items.length, loadEarlier, updateActiveAnchor]);

  const scrollToBottom = useCallback((): void => {
    const container = containerRef.current;
    if (!container) return;
    stickToBottomRef.current = true;
    seenCountRef.current = items.length;
    setUnseenCount(0);
    container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
  }, [items.length]);

  const scrollToItem = useCallback((itemId: string): void => {
    const container = containerRef.current;
    const target = container?.querySelector<HTMLElement>(`[data-chat-anchor-key="${CSS.escape(itemId)}"]`);
    if (!container || !target) return;
    stickToBottomRef.current = false;
    const offset = target.getBoundingClientRect().top - container.getBoundingClientRect().top;
    container.scrollTo({ top: container.scrollTop + offset - 16, behavior: 'smooth' });
    setActiveAnchorId(itemId);
  }, []);

  return {
    containerRef, loadingEarlier, handleScroll, loadEarlier,
    awayFromBottom, unseenCount, scrollToBottom, scrollToItem, activeAnchorId,
  };
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
