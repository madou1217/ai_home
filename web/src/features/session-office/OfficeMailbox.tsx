import { useCallback, useEffect, useMemo, useRef, useState, type FC } from 'react';
import { message } from 'antd';
import { writeClipboardText } from '@/utils/clipboard';
import { MailboxCliBar } from './mailbox-cli-bar';
import { MailboxDetailPane } from './mailbox-detail-pane';
import { MailboxHeader } from './mailbox-header';
import {
  buildCliHelperCommand,
  resolveReplyPeerTarget,
  resolveScopeTitle,
  resolveScopeTooltip,
  type BodyRenderMode,
  type CliCommandMode,
  type ScopeOptionItem,
} from './mailbox-helpers';
import { MailboxListPane } from './mailbox-list-pane';
import { buildRepliedMessageIdSet } from './peer-message-presentation';
import { buildSessionMailboxView } from './session-office-model';
import type {
  EnrichedPeerMessage,
  MailboxScope,
  MailboxStateFilter,
  OfficeProjectRoom,
  OfficeSessionItem,
  PeerCounts,
} from './session-office-types';
import './OfficeMailbox.css';

export interface OfficeMailboxProps {
  scope: MailboxScope;
  onScopeChange: (scope: MailboxScope) => void;
  focusedSession: OfficeSessionItem | null;
  activeRoom: OfficeProjectRoom | null;
  allRooms: OfficeProjectRoom[];
  allMessages: EnrichedPeerMessage[];
  unassignedMessages: EnrichedPeerMessage[];
  fullyUnassignedCount: number;
  counts: PeerCounts;
  loading: boolean;
  error: string;
  onRefresh: () => void;
  onJumpToSession?: (sessionKey: string, projectKey?: string | null) => void;
  initialMessageId?: string | null;
  compactHeader?: boolean;
}

const CLOCK_TICK_MS = 30_000;
const MOBILE_BREAKPOINT_QUERY = '(max-width: 719.98px)';

function readIsMobileViewport(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia(MOBILE_BREAKPOINT_QUERY).matches;
}

export const OfficeMailbox: FC<OfficeMailboxProps> = ({
  scope,
  onScopeChange,
  focusedSession,
  activeRoom,
  allRooms,
  allMessages,
  unassignedMessages,
  fullyUnassignedCount,
  counts,
  loading,
  error,
  onRefresh,
  onJumpToSession,
  initialMessageId,
  compactHeader = false,
}) => {
  const [stateFilter, setStateFilter] = useState<MailboxStateFilter>('attention');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(
    () => initialMessageId ?? null,
  );
  const [pinnedMessageId, setPinnedMessageId] = useState<string | null>(
    () => initialMessageId ?? null,
  );
  const [locallyReadIds, setLocallyReadIds] = useState<Set<string>>(() => new Set());
  const [bodyMode, setBodyMode] = useState<BodyRenderMode>('prose');
  const [cliMode, setCliMode] = useState<CliCommandMode>('reply');
  const [cliExpanded, setCliExpanded] = useState<boolean>(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [isMobileViewport, setIsMobileViewport] = useState<boolean>(readIsMobileViewport);
  const [mobileView, setMobileView] = useState<'list' | 'detail'>(
    () => (initialMessageId ? 'detail' : 'list'),
  );

  const copyTimerRef = useRef<number | null>(null);
  const listScrollRef = useRef<HTMLDivElement>(null);
  const readerScrollRef = useRef<HTMLDivElement>(null);
  const cliToggleBtnRef = useRef<HTMLButtonElement>(null);
  const listScrollMemoryRef = useRef<Map<string, number>>(new Map());
  const readerScrollMemoryRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, CLOCK_TICK_MS);
    return () => {
      window.clearInterval(timer);
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return undefined;
    }
    const mediaQuery = window.matchMedia(MOBILE_BREAKPOINT_QUERY);
    const updateViewport = () => setIsMobileViewport(mediaQuery.matches);
    updateViewport();
    mediaQuery.addEventListener('change', updateViewport);
    return () => mediaQuery.removeEventListener('change', updateViewport);
  }, []);

  useEffect(() => {
    setNowMs(Date.now());
  }, [allMessages]);

  useEffect(() => {
    if (initialMessageId) {
      setSelectedMessageId(initialMessageId);
      setPinnedMessageId(initialMessageId);
      setMobileView('detail');
    }
  }, [initialMessageId]);

  const repliedIds = useMemo(() => buildRepliedMessageIdSet(allMessages), [allMessages]);

  const mailboxView = useMemo(
    () =>
      buildSessionMailboxView(
        allMessages,
        focusedSession,
        activeRoom,
        scope,
        'all',
        stateFilter,
        searchQuery,
        'all',
        nowMs,
      ),
    [activeRoom, allMessages, focusedSession, nowMs, scope, searchQuery, stateFilter],
  );

  const selectedMessage = useMemo(() => {
    if (selectedMessageId) {
      const fromList = mailboxView.filteredMessages.find(
        (item) => item.id === selectedMessageId,
      );
      if (fromList) return fromList;
      if (pinnedMessageId === selectedMessageId) {
        const fromAll = allMessages.find((item) => item.id === selectedMessageId);
        if (fromAll) return fromAll;
      }
    }
    return mailboxView.filteredMessages[0] ?? null;
  }, [allMessages, mailboxView.filteredMessages, pinnedMessageId, selectedMessageId]);

  const listScrollKey = `${scope}|${stateFilter}|${searchQuery.trim()}`;

  const handleListScroll = useCallback(() => {
    if (listScrollRef.current) {
      listScrollMemoryRef.current.set(listScrollKey, listScrollRef.current.scrollTop);
    }
  }, [listScrollKey]);

  const handleReaderScroll = useCallback(() => {
    if (readerScrollRef.current && selectedMessage) {
      readerScrollMemoryRef.current.set(selectedMessage.id, readerScrollRef.current.scrollTop);
    }
  }, [selectedMessage]);

  useEffect(() => {
    if (isMobileViewport && mobileView === 'detail') return undefined;
    const savedTop = listScrollMemoryRef.current.get(listScrollKey) ?? 0;
    const frameId = window.requestAnimationFrame(() => {
      if (listScrollRef.current) {
        listScrollRef.current.scrollTop = savedTop;
      }
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [isMobileViewport, listScrollKey, mobileView]);

  useEffect(() => {
    const activeId = selectedMessage?.id ?? null;
    if (!activeId) return undefined;
    if (isMobileViewport && mobileView !== 'detail') return undefined;
    const savedTop = readerScrollMemoryRef.current.get(activeId) ?? 0;
    const frameId = window.requestAnimationFrame(() => {
      if (readerScrollRef.current) {
        readerScrollRef.current.scrollTop = savedTop;
      }
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [isMobileViewport, mobileView, selectedMessage?.id]);

  const handleCopy = useCallback(
    async (key: string, value: string, successText: string) => {
      try {
        await writeClipboardText(value);
        setCopiedKey(key);
        message.success(successText);
        if (copyTimerRef.current !== null) {
          window.clearTimeout(copyTimerRef.current);
        }
        copyTimerRef.current = window.setTimeout(() => {
          setCopiedKey((current) => (current === key ? null : current));
          copyTimerRef.current = null;
        }, 1600);
      } catch (copyError: unknown) {
        const detail =
          copyError instanceof Error ? copyError.message : '无法写入剪贴板';
        message.error(`复制失败: ${detail}`);
      }
    },
    [],
  );

  const handleToggleLocalRead = useCallback((messageId: string) => {
    setLocallyReadIds((prev) => {
      const next = new Set(prev);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }
      return next;
    });
  }, []);

  const handleSelectScope = useCallback(
    (nextScope: MailboxScope) => {
      setPinnedMessageId(null);
      setMobileView('list');
      onScopeChange(nextScope);
    },
    [onScopeChange],
  );

  const handleSelectStateFilter = useCallback((nextState: MailboxStateFilter) => {
    setPinnedMessageId(null);
    setStateFilter((current) =>
      current === nextState && nextState !== 'all' ? 'all' : nextState,
    );
  }, []);

  const handleSearchChange = useCallback((value: string) => {
    setPinnedMessageId(null);
    setSearchQuery(value);
  }, []);

  const handleResetFilters = useCallback(() => {
    setPinnedMessageId(null);
    setStateFilter('all');
    setSearchQuery('');
  }, []);

  const handleSelectMessage = useCallback((item: EnrichedPeerMessage) => {
    setPinnedMessageId(null);
    setSelectedMessageId(item.id);
    setMobileView('detail');
  }, []);

  const handleJumpToMessage = useCallback(
    (targetMessage: EnrichedPeerMessage) => {
      setPinnedMessageId(targetMessage.id);
      setSelectedMessageId(targetMessage.id);
      setMobileView('detail');
      const inCurrentView = mailboxView.filteredMessages.some(
        (item) => item.id === targetMessage.id,
      );
      if (!inCurrentView) {
        setStateFilter('all');
        setSearchQuery('');
        if (scope !== 'all') {
          onScopeChange('all');
        }
      }
    },
    [mailboxView.filteredMessages, onScopeChange, scope],
  );

  const handleFocusReplyCli = useCallback(() => {
    setCliMode('reply');
    setCliExpanded(true);
    window.requestAnimationFrame(() => {
      cliToggleBtnRef.current?.focus();
    });
  }, []);

  const handleMobileBack = useCallback(() => {
    setMobileView('list');
  }, []);

  const scopeOptions = useMemo<ScopeOptionItem[]>(() => {
    const items: ScopeOptionItem[] = [];

    if (scope === 'session' || (compactHeader && focusedSession)) {
      items.push({
        key: 'session',
        label: '工位',
        disabled: !focusedSession,
        tooltip: focusedSession
          ? `${focusedSession.shortLabel || focusedSession.label} (${focusedSession.projectName})`
          : '未聚焦具体工位',
      });
    }

    items.push({
      key: 'unassigned',
      label: '未归属',
      count: unassignedMessages.length,
      tooltip: `含未解析端点 ${unassignedMessages.length} 条（完全未归属 ${fullyUnassignedCount} 条）`,
    });

    items.push({
      key: 'room',
      label: '当前房间',
      count: activeRoom?.roomMessages.length,
      disabled: !activeRoom,
      tooltip: activeRoom
        ? `${activeRoom.projectName} · ${activeRoom.roomMessages.length} 条消息`
        : '当前未选择项目房间',
    });

    items.push({
      key: 'all',
      label: '全部',
      count: counts.total,
      tooltip: `当前服务器全部 ${counts.total} 条协作消息`,
    });

    return items;
  }, [
    activeRoom,
    compactHeader,
    counts.total,
    focusedSession,
    fullyUnassignedCount,
    scope,
    unassignedMessages.length,
  ]);

  const headerTitle = useMemo(() => resolveScopeTitle(scope), [scope]);
  const headerTooltip = useMemo(
    () => resolveScopeTooltip(scope, activeRoom, focusedSession, stateFilter === 'attention'),
    [activeRoom, focusedSession, scope, stateFilter],
  );

  const visibleCount = mailboxView.filteredMessages.length;
  const hasActiveFilter = stateFilter !== 'all' || searchQuery.trim().length > 0;

  const cliSendTarget = selectedMessage
    ? resolveReplyPeerTarget(selectedMessage, focusedSession)
    : '';
  const effectiveCliMode: CliCommandMode =
    cliMode === 'send' && cliSendTarget ? 'send' : 'reply';

  const cliCommandText = useMemo(() => {
    if (!selectedMessage) return '';
    return buildCliHelperCommand(selectedMessage, effectiveCliMode, focusedSession);
  }, [effectiveCliMode, focusedSession, selectedMessage]);

  const effectiveMobileView: 'list' | 'detail' =
    isMobileViewport && mobileView === 'detail' && selectedMessage ? 'detail' : 'list';

  return (
    <section
      className={`office-mailbox${compactHeader ? ' office-mailbox--compact' : ''}`}
      data-mobile-view={effectiveMobileView}
      aria-label={headerTitle}
    >
      <MailboxHeader
        compactHeader={compactHeader}
        scope={scope}
        scopeOptions={scopeOptions}
        title={headerTitle}
        titleTooltip={headerTooltip}
        visibleCount={visibleCount}
        scopeTotalCount={mailboxView.allCount}
        searchQuery={searchQuery}
        loading={loading}
        error={error}
        onSelectScope={handleSelectScope}
        onSearchChange={handleSearchChange}
        onRefresh={onRefresh}
      />

      <div className="office-mailbox-body">
        <MailboxListPane
          stateFilter={stateFilter}
          attentionCount={mailboxView.attentionCount}
          undeliveredCount={mailboxView.undeliveredCount}
          deliveredOrReadCount={mailboxView.deliveredOrReadCount}
          scopeAllCount={mailboxView.allCount}
          visibleCount={visibleCount}
          hasActiveFilter={hasActiveFilter}
          loading={loading}
          scope={scope}
          activeRoom={activeRoom}
          totalCount={counts.total}
          messages={mailboxView.filteredMessages}
          selectedMessageId={selectedMessage?.id ?? null}
          nowMs={nowMs}
          repliedIds={repliedIds}
          locallyReadIds={locallyReadIds}
          listRef={listScrollRef}
          onListScroll={handleListScroll}
          onSelectStateFilter={handleSelectStateFilter}
          onResetFilters={handleResetFilters}
          onSelectScope={handleSelectScope}
          onSelectMessage={handleSelectMessage}
          onRefresh={onRefresh}
        />

        <MailboxDetailPane
          messageItem={selectedMessage}
          allMessages={allMessages}
          allRooms={allRooms}
          focusedSession={focusedSession}
          activeRoom={activeRoom}
          nowMs={nowMs}
          repliedIds={repliedIds}
          isLocallyRead={selectedMessage ? locallyReadIds.has(selectedMessage.id) : false}
          onToggleLocalRead={handleToggleLocalRead}
          bodyMode={bodyMode}
          onBodyModeChange={setBodyMode}
          copiedKey={copiedKey}
          onCopy={handleCopy}
          onJumpToMessage={handleJumpToMessage}
          onJumpToSession={onJumpToSession}
          onFocusReplyCli={handleFocusReplyCli}
          showMobileBack={isMobileViewport && effectiveMobileView === 'detail'}
          onMobileBack={handleMobileBack}
          readerScrollRef={readerScrollRef}
          onReaderScroll={handleReaderScroll}
          cliFooter={
            selectedMessage ? (
              <MailboxCliBar
                targetMessage={selectedMessage}
                cliMode={cliMode}
                cliSendTarget={cliSendTarget}
                cliCommandText={cliCommandText}
                expanded={cliExpanded}
                copiedKey={copiedKey}
                toggleBtnRef={cliToggleBtnRef}
                onToggleExpanded={() => setCliExpanded((prev) => !prev)}
                onModeChange={setCliMode}
                onCopy={handleCopy}
              />
            ) : null
          }
        />
      </div>
    </section>
  );
};

export default OfficeMailbox;
