import type { MutableRefObject } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createRetryCountdown,
  getThinkingStatusText,
} from '@/components/chat/provider-pending-policy.js';
import type {
  RetryCountdown,
  RetryStatus,
} from '@/components/chat/provider-pending-policy.js';
import type { ChatMessage, Session } from '@/types';
import {
  isSameLegacySession,
} from './legacy-session-history-state';
import { finalizePendingAssistantFailure } from './legacy-run-message-policy';
import { useLegacyHistoryProjection } from './use-legacy-history-projection';
import {
  useSelectedSessionWatch,
} from './use-selected-session-watch';
import { useSessionResumeLifecycle } from './use-session-resume-lifecycle';
import { useRetryCountdownStatus } from './use-retry-countdown-status';
import type {
  LegacySessionWatchDisposition,
  LegacySessionWatchPayload,
} from './use-selected-session-watch';

export { legacySessionCacheKey } from './legacy-session-history-state';
export type {
  LegacySessionWatchDisposition,
  LegacySessionWatchPayload,
} from './use-selected-session-watch';

interface LegacySessionHistoryOptions {
  readonly enabled: boolean;
  readonly selectedSession: Session | null;
  readonly selectedSessionRef: MutableRefObject<Session | null>;
  readonly isSessionRunning: (session: Session) => boolean;
  readonly onToolCallBoundary: (session: Session) => void;
  readonly onWatchEvent: (
    session: Session,
    payload: LegacySessionWatchPayload,
  ) => LegacySessionWatchDisposition;
  readonly onWatchSettled: (session: Session) => void;
  readonly onHistoryHydrated: (session: Session) => void;
  readonly pauseProjectWatch: () => void;
  readonly resumeProjectWatch: () => void;
  readonly refreshProjects: () => Promise<void>;
}

export interface LegacySessionHistoryController {
  readonly messages: ChatMessage[];
  readonly hasMoreHistory: boolean;
  readonly watchPendingStatus: string | null;
  readonly appendVisibleMessage: (message: ChatMessage) => void;
  readonly replaceVisibleMessages: (messages: ChatMessage[]) => void;
  readonly dropPendingAssistantPlaceholder: () => void;
  readonly updatePendingAssistantStatus: (statusText: string) => void;
  readonly loadMoreHistory: () => Promise<void>;
  readonly reloadSessionHistory: (session: Session) => Promise<void>;
  readonly clearVisibleHistory: () => void;
  readonly readSessionMessages: (session: Session) => ChatMessage[] | undefined;
  readonly replaceSessionMessages: (session: Session, history: ChatMessage[]) => boolean;
  readonly clearWatchPending: () => void;
  readonly markWatchPending: (session: Session, statusText?: string) => void;
  readonly markWatchRetry: (session: Session, retryStatus: RetryStatus) => void;
}

export function useLegacySessionHistory({
  enabled,
  selectedSession,
  selectedSessionRef,
  isSessionRunning,
  onToolCallBoundary,
  onWatchEvent,
  onWatchSettled,
  onHistoryHydrated,
  pauseProjectWatch,
  resumeProjectWatch,
  refreshProjects,
}: LegacySessionHistoryOptions): LegacySessionHistoryController {
  const [watchPendingText, setWatchPendingText] = useState<string | null>(null);
  const [watchRetryCountdown, setWatchRetryCountdown] = useState<RetryCountdown | null>(null);
  const watchPendingStartedAtRef = useRef(0);
  const watchRetryStatus = useRetryCountdownStatus(watchRetryCountdown);
  const watchPendingStatus = watchRetryStatus || watchPendingText;

  const clearWatchPending = useCallback((): void => {
    watchPendingStartedAtRef.current = 0;
    setWatchPendingText(null);
    setWatchRetryCountdown(null);
  }, []);

  const markWatchPending = useCallback((
    session: Session,
    statusText = getThinkingStatusText(session.provider),
  ): void => {
    if (!isSameLegacySession(selectedSessionRef.current, session)) return;
    if (!watchPendingStartedAtRef.current) watchPendingStartedAtRef.current = Date.now();
    setWatchRetryCountdown(null);
    setWatchPendingText(statusText);
  }, [selectedSessionRef]);

  const markWatchRetry = useCallback((session: Session, retryStatus: RetryStatus): void => {
    if (!isSameLegacySession(selectedSessionRef.current, session)) return;
    const startedAt = Date.now();
    if (!watchPendingStartedAtRef.current) watchPendingStartedAtRef.current = startedAt;
    setWatchPendingText(null);
    setWatchRetryCountdown(createRetryCountdown(retryStatus, session.provider, startedAt));
  }, [selectedSessionRef]);

  const history = useLegacyHistoryProjection({
    enabled,
    selectedSession,
    selectedSessionRef,
    isSessionRunning,
    onToolCallBoundary,
    onHistoryHydrated,
    clearWatchPending,
    markWatchPending,
  });
  const readSessionMessages = history.readSessionMessages;
  const replaceSessionMessages = history.replaceSessionMessages;
  const markWatchFailed = useCallback((session: Session, failureText: string): void => {
    const current = readSessionMessages(session) || [];
    replaceSessionMessages(
      session,
      finalizePendingAssistantFailure(current, failureText),
    );
    clearWatchPending();
  }, [clearWatchPending, readSessionMessages, replaceSessionMessages]);
  const sessionWatch = useSelectedSessionWatch({
    enabled,
    selectedSession,
    selectedSessionRef,
    onWatchEvent,
    onWatchSettled,
    clearWatchPending,
    markWatchPending,
    markWatchRetry,
    markWatchFailed,
    scheduleSessionReload: history.scheduleSessionReload,
    cancelSessionReloads: history.cancelSessionReloads,
  });

  useSessionResumeLifecycle({
    enabled,
    selectedSessionRef,
    connectSessionWatch: sessionWatch.connect,
    reloadSessionHistory: history.reloadSessionHistory,
    pauseProjectWatch,
    resumeProjectWatch,
    refreshProjects,
  });

  useEffect(() => {
    clearWatchPending();
  }, [
    clearWatchPending,
    selectedSession?.draft,
    selectedSession?.id,
    selectedSession?.projectDirName,
    selectedSession?.provider,
  ]);

  return {
    messages: history.messages,
    hasMoreHistory: history.hasMoreHistory,
    watchPendingStatus,
    appendVisibleMessage: history.appendVisibleMessage,
    replaceVisibleMessages: history.replaceVisibleMessages,
    dropPendingAssistantPlaceholder: history.dropPendingAssistantPlaceholder,
    updatePendingAssistantStatus: history.updatePendingAssistantStatus,
    loadMoreHistory: history.loadMoreHistory,
    reloadSessionHistory: history.reloadSessionHistory,
    clearVisibleHistory: history.clearVisibleHistory,
    readSessionMessages: history.readSessionMessages,
    replaceSessionMessages: history.replaceSessionMessages,
    clearWatchPending,
    markWatchPending,
    markWatchRetry,
  };
}
