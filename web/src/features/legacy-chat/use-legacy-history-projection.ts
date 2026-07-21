import type { MutableRefObject } from 'react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { message } from 'antd';
import {
  isSessionRequestCancelled,
  sessionsAPI,
} from '@/services/api';
import {
  CHAT_SESSION_HISTORY_LOAD_MESSAGE_KEY,
  clearLoadFailureMessage,
  showLoadFailureMessage,
} from '@/services/load-failure-message.js';
import {
  advanceSessionHistoryWindow,
  didSessionHistoryCursorReset,
  didSessionHistorySnapshotReset,
  isSessionHistorySnapshotCurrent,
  loadContiguousSessionHistoryTail,
  rebaseLatestSessionHistoryTail,
  rebaseOlderSessionHistoryPage,
} from '@/services/session-history-window.js';
import {
  getThinkingStatusText,
} from '@/components/chat/provider-pending-policy.js';
import {
  supportsIncrementalSessionEvents,
} from '@/components/chat/provider-capabilities.js';
import type {
  ChatMessage,
  Session,
  SessionEventItem,
  SessionMessageBundle,
} from '@/types';
import {
  dedupeChatMessages,
  isPureSessionHistoryAppend,
} from './message-history-policy';
import {
  isSameLegacySession,
  legacySessionCacheKey,
  legacySessionEffectKey,
  LegacySessionHistoryState,
} from './legacy-session-history-state';
import { projectLegacySessionEvents } from './legacy-session-event-projector';

const INITIAL_MESSAGE_COUNT = 30;
const LOAD_MORE_MESSAGE_COUNT = 20;
const SESSION_RELOAD_DELAY_MS = 180;
const REASONING_SNAPSHOT_DELAY_MS = 420;

interface LegacyHistoryProjectionOptions {
  readonly enabled: boolean;
  readonly selectedSession: Session | null;
  readonly selectedSessionRef: MutableRefObject<Session | null>;
  readonly isSessionRunning: (session: Session) => boolean;
  readonly onToolCallBoundary: (session: Session) => void;
  readonly onHistoryHydrated: (session: Session) => void;
  readonly clearWatchPending: () => void;
  readonly markWatchPending: (session: Session, statusText?: string) => void;
}

export interface LegacyHistoryProjection {
  readonly messages: ChatMessage[];
  readonly hasMoreHistory: boolean;
  readonly appendVisibleMessage: (message: ChatMessage) => void;
  readonly replaceVisibleMessages: (messages: ChatMessage[]) => void;
  readonly dropPendingAssistantPlaceholder: () => void;
  readonly updatePendingAssistantStatus: (statusText: string) => void;
  readonly loadMoreHistory: () => Promise<void>;
  readonly reloadSessionHistory: (session: Session) => Promise<void>;
  readonly scheduleSessionReload: (session: Session, delayMs?: number) => void;
  readonly cancelSessionReloads: (session: Session) => void;
  readonly clearVisibleHistory: () => void;
  readonly readSessionMessages: (session: Session) => ChatMessage[] | undefined;
  readonly replaceSessionMessages: (session: Session, history: ChatMessage[]) => boolean;
}

export function useLegacyHistoryProjection({
  enabled,
  selectedSession,
  selectedSessionRef,
  isSessionRunning,
  onToolCallBoundary,
  onHistoryHydrated,
  clearWatchPending,
  markWatchPending,
}: LegacyHistoryProjectionOptions): LegacyHistoryProjection {
  const [allMessages, setAllMessages] = useState<ChatMessage[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const historyStateRef = useRef<LegacySessionHistoryState | null>(null);
  const selectionRevisionRef = useRef(0);
  const reloadTimersRef = useRef<Map<string, number>>(new Map());
  const reloadSessionHistoryRef = useRef<(session: Session) => Promise<void>>(async () => {});
  const applySessionEventsRef = useRef<(
    session: Session,
    events: SessionEventItem[],
    cursor?: number,
  ) => void>(() => {});
  if (!historyStateRef.current) historyStateRef.current = new LegacySessionHistoryState();
  const historyState = historyStateRef.current;

  const clearVisibleHistory = useCallback((): void => {
    setMessages([]);
    setAllMessages([]);
    setHasMoreHistory(false);
  }, []);

  const applySessionHistory = useCallback((history: ChatMessage[]): void => {
    const normalizedHistory = dedupeChatMessages(history);
    setAllMessages(normalizedHistory);
    if (normalizedHistory.length > INITIAL_MESSAGE_COUNT) {
      setMessages(normalizedHistory.slice(-INITIAL_MESSAGE_COUNT));
      setHasMoreHistory(true);
      return;
    }
    setMessages(normalizedHistory);
    setHasMoreHistory(false);
  }, []);

  const applyReloadedSessionHistory = useCallback((
    previous: ChatMessage[],
    next: ChatMessage[],
  ): void => {
    const dedupedPrevious = dedupeChatMessages(previous);
    const normalizedNext = dedupeChatMessages(next);
    if (dedupedPrevious.length > 0
      && isPureSessionHistoryAppend(dedupedPrevious, normalizedNext)) {
      const appended = normalizedNext.slice(dedupedPrevious.length);
      if (appended.length === 0) return;
      setAllMessages(normalizedNext);
      setMessages((current) => [...current, ...appended]);
      return;
    }
    applySessionHistory(normalizedNext);
  }, [applySessionHistory]);

  const appendVisibleMessage = useCallback((nextMessage: ChatMessage): void => {
    setMessages((current) => [...current, nextMessage]);
  }, []);

  const replaceVisibleMessages = useCallback((nextMessages: ChatMessage[]): void => {
    setMessages(nextMessages);
  }, []);

  const dropPendingAssistantPlaceholder = useCallback((): void => {
    setMessages((current) => {
      const last = current[current.length - 1];
      if (!last || last.role !== 'assistant' || !last.pending) return current;
      return current.slice(0, -1);
    });
  }, []);

  const updatePendingAssistantStatus = useCallback((statusText: string): void => {
    setMessages((current) => {
      const last = current[current.length - 1];
      if (!last || last.role !== 'assistant' || !last.pending) return current;
      const next = current.slice();
      next[next.length - 1] = { ...last, statusText };
      return next;
    });
  }, []);

  const readSessionMessages = useCallback((session: Session): ChatMessage[] | undefined => (
    historyState.readMessages(session)
  ), [historyState]);

  const replaceSessionMessages = useCallback((session: Session, history: ChatMessage[]): boolean => {
    historyState.writeMessages(session, history);
    if (!isSameLegacySession(selectedSessionRef.current, session)) return false;
    applySessionHistory(history);
    return true;
  }, [applySessionHistory, historyState, selectedSessionRef]);

  const loadMoreHistory = useCallback(async (): Promise<void> => {
    const session = selectedSessionRef.current;
    if (!session || session.draft || !enabled) return;
    const selectionRevision = selectionRevisionRef.current;
    const historyWindow = historyState.readWindow(session);
    const currentLength = messages.length;
    const totalLength = allMessages.length;
    if (currentLength < totalLength) {
      const moreCount = Math.min(LOAD_MORE_MESSAGE_COUNT, totalLength - currentLength);
      const startIndex = totalLength - currentLength - moreCount;
      setMessages(allMessages.slice(Math.max(0, startIndex)));
      setHasMoreHistory(startIndex > 0 || Boolean(historyWindow?.hasMore));
      return;
    }
    if (!historyWindow?.hasMore || !historyState.beginOlderPageLoad(session)) return;

    try {
      const olderPage = await sessionsAPI.getSessionMessagesBundle(
        session.provider,
        session.id,
        session.projectDirName,
        { before: historyWindow.start, limit: LOAD_MORE_MESSAGE_COUNT },
      );
      const latestWindow = historyState.readWindow(session) || historyWindow;
      const merged = rebaseOlderSessionHistoryPage(latestWindow, olderPage) as SessionMessageBundle;
      const addedCount = Math.max(0, latestWindow.start - merged.start);
      historyState.writeWindow(session, merged);
      historyState.writeMessages(session, merged.messages);
      if (!isSameLegacySession(selectedSessionRef.current, session)
        || selectionRevisionRef.current !== selectionRevision) return;
      setAllMessages(merged.messages);
      setMessages((current) => [...merged.messages.slice(0, addedCount), ...current]);
      setHasMoreHistory(merged.hasMore);
      clearLoadFailureMessage(message, CHAT_SESSION_HISTORY_LOAD_MESSAGE_KEY);
    } catch (error) {
      if (isSameLegacySession(selectedSessionRef.current, session)
        && selectionRevisionRef.current === selectionRevision
        && !isSessionRequestCancelled(error)) {
        showLoadFailureMessage(
          message,
          CHAT_SESSION_HISTORY_LOAD_MESSAGE_KEY,
          '加载更早的会话历史失败',
        );
      }
    } finally {
      historyState.finishOlderPageLoad(session);
    }
  }, [allMessages, enabled, historyState, messages.length, selectedSessionRef]);

  const reloadSessionHistory = useCallback(async (session: Session): Promise<void> => {
    if (session.draft || !enabled) return;
    const cacheKey = legacySessionCacheKey(session);
    const snapshotRetryKey = `${cacheKey}:snapshot-retry`;
    const reasoningSnapshotKey = `${cacheKey}:reasoning-snapshot`;
    const previousWindow = historyState.readWindow(session);
    let loadedWindow: SessionMessageBundle | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      loadedWindow = await loadContiguousSessionHistoryTail(
        previousWindow,
        (options: { before?: number }) => sessionsAPI.getSessionMessagesBundle(
          session.provider,
          session.id,
          session.projectDirName,
          options,
        ),
      ) as SessionMessageBundle;
      const observedCursor = historyState.readCursor(session);
      if (didSessionHistorySnapshotReset(previousWindow, loadedWindow, observedCursor)) {
        historyState.resetSnapshot(session);
        historyState.writeCursor(session, loadedWindow.cursor);
        break;
      }
      if (isSessionHistorySnapshotCurrent(observedCursor, loadedWindow)) break;
      loadedWindow = null;
    }
    if (!loadedWindow) {
      if (!isSameLegacySession(selectedSessionRef.current, session)) return;
      if (!reloadTimersRef.current.has(snapshotRetryKey)) {
        const retryTimer = window.setTimeout(() => {
          reloadTimersRef.current.delete(snapshotRetryKey);
          if (!isSameLegacySession(selectedSessionRef.current, session)) return;
          reloadSessionHistoryRef.current(session).catch(() => {});
        }, SESSION_RELOAD_DELAY_MS);
        reloadTimersRef.current.set(snapshotRetryKey, retryTimer);
      }
      return;
    }

    clearReloadTimer(reloadTimersRef.current, snapshotRetryKey);
    clearReloadTimer(reloadTimersRef.current, reasoningSnapshotKey);
    const nextWindow = rebaseLatestSessionHistoryTail(
      historyState.readWindow(session),
      loadedWindow,
    ) as SessionMessageBundle;
    const previousHistory = historyState.readMessages(session) || [];
    const history = nextWindow.messages;
    historyState.writeWindow(session, nextWindow);
    historyState.writeMessages(session, history);
    historyState.writeCursor(session, nextWindow.cursor);
    if (isSameLegacySession(selectedSessionRef.current, session)) {
      const latest = history[history.length - 1];
      const previousLatest = previousHistory[previousHistory.length - 1];
      const hasNewAssistantReply = Boolean(latest
        && latest.role === 'assistant'
        && (history.length > previousHistory.length
          || String(latest.content || '') !== String(previousLatest?.content || '')
          || String(latest.timestamp || '') !== String(previousLatest?.timestamp || '')));
      if (hasNewAssistantReply) clearWatchPending();
      applyReloadedSessionHistory(previousHistory, history);
      if (nextWindow.hasMore) setHasMoreHistory(true);
      clearLoadFailureMessage(message, CHAT_SESSION_HISTORY_LOAD_MESSAGE_KEY);
    }
  }, [
    applyReloadedSessionHistory,
    clearWatchPending,
    enabled,
    historyState,
    selectedSessionRef,
  ]);
  reloadSessionHistoryRef.current = reloadSessionHistory;

  const applySessionEvents = useCallback((
    session: Session,
    events: SessionEventItem[],
    cursor = 0,
  ): void => {
    if (!Array.isArray(events) || events.length === 0 || !enabled) return;
    const isCurrentSession = isSameLegacySession(selectedSessionRef.current, session);
    const projection = projectLegacySessionEvents({
      messages: historyState.readMessages(session) || [],
      events,
      session,
      current: isCurrentSession,
      running: isSessionRunning(session),
    });
    projection.effects.forEach((effect) => {
      if (effect === 'clear_pending') clearWatchPending();
      if (effect === 'mark_thinking') {
        markWatchPending(session, getThinkingStatusText(session.provider));
      }
      if (effect === 'tool_boundary') onToolCallBoundary(session);
    });
    const normalizedMessages = projection.messages;
    historyState.writeMessages(session, normalizedMessages);
    const nextWindow = advanceSessionHistoryWindow(
      historyState.readWindow(session),
      normalizedMessages,
      cursor,
    ) as SessionMessageBundle | null;
    if (nextWindow) historyState.writeWindow(session, nextWindow);
    if (isCurrentSession) applySessionHistory(normalizedMessages);
  }, [
    applySessionHistory,
    clearWatchPending,
    enabled,
    historyState,
    isSessionRunning,
    markWatchPending,
    onToolCallBoundary,
    selectedSessionRef,
  ]);
  applySessionEventsRef.current = applySessionEvents;

  const scheduleSessionReload = useCallback((
    session: Session,
    delayMs = SESSION_RELOAD_DELAY_MS,
  ): void => {
    if (!enabled) return;
    const cacheKey = legacySessionCacheKey(session);
    const reasoningSnapshotKey = `${cacheKey}:reasoning-snapshot`;
    clearReloadTimer(reloadTimersRef.current, cacheKey);
    const nextTimer = window.setTimeout(() => {
      reloadTimersRef.current.delete(cacheKey);
      if (!supportsIncrementalSessionEvents(session.provider)) {
        reloadSessionHistoryRef.current(session).catch(() => {});
        return;
      }
      const currentCursor = historyState.readCursor(session);
      sessionsAPI.getSessionEvents(
        session.provider,
        session.id,
        currentCursor,
        session.projectDirName,
      ).then((payload) => {
        if (didSessionHistoryCursorReset(currentCursor, payload.cursor)) {
          historyState.resetSnapshot(session);
        }
        historyState.writeCursor(session, payload.cursor);
        if (payload.events?.length > 0) {
          applySessionEventsRef.current(session, payload.events, payload.cursor);
        }
        if (!payload.requiresSnapshot) return undefined;
        if (payload.events?.some((event) => event.type === 'assistant_reasoning')) {
          clearReloadTimer(reloadTimersRef.current, reasoningSnapshotKey);
          const reasoningSnapshotTimer = window.setTimeout(() => {
            reloadTimersRef.current.delete(reasoningSnapshotKey);
            if (!isSameLegacySession(selectedSessionRef.current, session)) return;
            reloadSessionHistoryRef.current(session).catch(() => {});
          }, REASONING_SNAPSHOT_DELAY_MS);
          reloadTimersRef.current.set(reasoningSnapshotKey, reasoningSnapshotTimer);
          return undefined;
        }
        return reloadSessionHistoryRef.current(session);
      }).catch((error) => {
        if (!isSessionRequestCancelled(error)) {
          reloadSessionHistoryRef.current(session).catch(() => {});
        }
      });
    }, delayMs);
    reloadTimersRef.current.set(cacheKey, nextTimer);
  }, [enabled, historyState, selectedSessionRef]);

  const cancelSessionReloads = useCallback((session: Session): void => {
    const cacheKey = legacySessionCacheKey(session);
    [cacheKey, `${cacheKey}:snapshot-retry`, `${cacheKey}:reasoning-snapshot`]
      .forEach((key) => clearReloadTimer(reloadTimersRef.current, key));
  }, []);

  const selectedSessionKey = legacySessionEffectKey(selectedSession);

  useLayoutEffect(() => {
    selectionRevisionRef.current += 1;
  }, [
    selectedSession?.provider,
    selectedSession?.id,
    selectedSession?.projectDirName,
    selectedSession?.draft,
  ]);

  useEffect(() => {
    const session = selectedSessionRef.current;
    if (!session || legacySessionEffectKey(session) !== selectedSessionKey) return;
    if (!enabled) {
      clearVisibleHistory();
      return;
    }
    if (session.draft) {
      const cachedDraftMessages = historyState.readMessages(session);
      if (cachedDraftMessages?.length) applySessionHistory(cachedDraftMessages);
      else clearVisibleHistory();
      clearLoadFailureMessage(message, CHAT_SESSION_HISTORY_LOAD_MESSAGE_KEY);
      return;
    }

    let disposed = false;
    const loadMessages = async (): Promise<void> => {
      const cached = historyState.readMessages(session);
      const cachedWindow = historyState.readWindow(session);
      if (cached?.length) {
        applySessionHistory(cached);
        if (cachedWindow?.hasMore) setHasMoreHistory(true);
      } else {
        clearVisibleHistory();
      }
      try {
        await reloadSessionHistory(session);
        if (!disposed) onHistoryHydrated(session);
      } catch (error) {
        if (!disposed && !isSessionRequestCancelled(error)) {
          showLoadFailureMessage(
            message,
            CHAT_SESSION_HISTORY_LOAD_MESSAGE_KEY,
            '加载会话历史失败',
          );
        }
      }
    };
    loadMessages().catch(() => {});
    return () => {
      disposed = true;
    };
  }, [
    applySessionHistory,
    clearVisibleHistory,
    enabled,
    historyState,
    onHistoryHydrated,
    reloadSessionHistory,
    selectedSessionKey,
    selectedSessionRef,
  ]);

  useEffect(() => () => {
    reloadTimersRef.current.forEach((timerId) => window.clearTimeout(timerId));
    reloadTimersRef.current.clear();
  }, []);

  return {
    messages,
    hasMoreHistory,
    appendVisibleMessage,
    replaceVisibleMessages,
    dropPendingAssistantPlaceholder,
    updatePendingAssistantStatus,
    loadMoreHistory,
    reloadSessionHistory,
    scheduleSessionReload,
    cancelSessionReloads,
    clearVisibleHistory,
    readSessionMessages,
    replaceSessionMessages,
  };
}

function clearReloadTimer(timers: Map<string, number>, key: string): void {
  const timer = timers.get(key);
  if (timer === undefined) return;
  window.clearTimeout(timer);
  timers.delete(key);
}
